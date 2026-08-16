/**
 * The admin portal's content-editing API (AB#7420 / AB#7421 — plan §3).
 *
 * Every route here is gated by `requireAdmin()`: a real account carrying the
 * operator flag, the same session cookie the rest of the portal uses. There is
 * no ADMIN_KEY door on any of it — unlike POST /publish, none of this is called
 * by a headless process, so nothing here needs a credential a browser can't
 * hold.
 *
 * ── How this coexists with POST /publish-story ──────────────────────────────
 * They are two different paths for two different deployments, and both stay.
 *
 *   • `/publish-story` (docs/design/admin-publish.md) commits markdown to the
 *     site's GitHub repo and dispatches publish.yml. It needs GITHUB_REPO +
 *     GITHUB_DEPLOY_TOKEN, it publishes ONE new single-chapter story, it cannot
 *     edit anything that already exists, and it produces narration because CI
 *     can run the TTS model.
 *   • These routes need no GitHub at all. They edit any chapter of any book in
 *     place, instantly, because the deployment now holds its own source. What
 *     they cannot do is narrate.
 *
 * Unifying them was considered and rejected: the GitHub path's whole value is
 * that the repo stays the audit log and CI does the narration, and folding it
 * into a direct storage write would delete both. A site with a repo keeps using
 * it for new work; every site, repo or not, can now fix a typo.
 *
 * ── Where an edit's narration goes ──────────────────────────────────────────
 * Nowhere, in-request, and that is stated rather than hidden. A Worker cannot
 * run the TTS model, so a text edit publishes instantly and marks the chapter
 * `audioStale`; the next `publish.mjs` run (which can now pull the portal's
 * source back down with `--pull`) re-narrates it and clears the flag. The
 * portal says so on the chapter, in those words.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../types';
import type { BookEntry, ChapterEntry } from '../content-types';
import { requireAdmin } from '../lib/session';
import { getText, IMMUTABLE, type ContentStore } from '../lib/content-store';
import {
  ID_RE,
  announceVersionOf,
  findBook,
  findChapter,
  key,
  listRevisions,
  readManifest,
  readRevision,
  revisionLimit,
  saveChapter,
  storeOf,
  validateSource,
  writeManifest,
} from '../lib/content';
import { chapterMeta, parseBlocks, readFrontmatter } from '../lib/md';
import { sha256Bytes } from '../lib/crypto';
import { recordPublish } from '../lib/notify';

export const adminContent = new Hono<AppContext>();

adminContent.use('/*', requireAdmin());

const DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Image types the reader can actually render, and that are safe on a shared
 *  content origin. SVG is deliberately excluded: it is a script-carrying
 *  document, and the content origin serves it to the same browser as the app. */
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/**
 * Every route needs the same three things: a store, a valid book id, and
 * (usually) a valid chapter id. This returns them or the error response.
 */
function resolve(c: Context<AppContext>, needChapter: boolean): { store: ContentStore; bookId: string; chapterId: string } | Response {
  const store = storeOf(c);
  if (!store) {
    return c.json(
      {
        error: 'no_content_store',
        message:
          'This deployment has no writable content storage bound, so content cannot be edited from the portal. See docs/admin-guide.md.',
      },
      501
    );
  }
  const bookId = c.req.param('bookId') ?? '';
  const chapterId = c.req.param('chapterId') ?? '';
  if (!ID_RE.test(bookId)) return c.json({ error: 'invalid_book_id', message: 'Book ids are 1-64 lowercase letters, digits or hyphens.' }, 400);
  if (needChapter && !ID_RE.test(chapterId)) {
    return c.json({ error: 'invalid_chapter_id', message: 'Chapter ids are 1-64 lowercase letters, digits or hyphens.' }, 400);
  }
  return { store, bookId, chapterId };
}

/** Whoever is signed in, in the form worth showing next to a revision. */
function actor(c: Context<AppContext>): string {
  const user = c.get('user');
  return user?.username || user?.email || 'operator';
}

/**
 * The portal's library listing.
 *
 * Answered entirely from `manifest.json` — no per-chapter storage reads — so a
 * library of two hundred short stories costs the same one GET as a library of
 * one. That is why `source` and `audioStale` live on the manifest entry rather
 * than being probed: a listing that did a storage round trip per chapter would
 * be unusable on exactly the deployment shape (many single-chapter books) this
 * has to serve well.
 *
 * `editable` per chapter is the honest bit: a chapter published before source
 * upload existed has no `source` key, so it can be READ from its derived JSON
 * but not round-tripped as markdown. The portal offers to adopt it rather than
 * pretending or failing.
 */
adminContent.get('/content/books', async (c) => {
  const store = storeOf(c);
  if (!store) return c.json({ storeAvailable: false, books: [], libraryVersion: 0, announceVersion: 0, revisionLimit: revisionLimit(c.env) });
  const manifest = await readManifest(store);
  if (!manifest) {
    return c.json({ storeAvailable: true, books: [], libraryVersion: 0, announceVersion: 0, revisionLimit: revisionLimit(c.env) });
  }
  return c.json({
    storeAvailable: true,
    contentOrigin: c.env.CONTENT_ORIGIN,
    libraryVersion: manifest.libraryVersion,
    announceVersion: announceVersionOf(manifest),
    revisionLimit: revisionLimit(c.env),
    books: (manifest.books ?? []).map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      description: b.description,
      cover: b.cover,
      chapterCount: b.chapters?.length ?? 0,
      chapters: (b.chapters ?? []).map((ch) => ({
        id: ch.id,
        title: ch.title,
        label: ch.label,
        wordCount: ch.wordCount,
        readingTime: ch.readingTime,
        hasAudio: ch.hasAudio,
        audioStale: ch.audioStale === true,
        hasSource: typeof ch.source === 'string' && ch.source.length > 0,
        contentHash: ch.contentHash,
        publishedAt: ch.publishedAt,
      })),
    })),
  });
});

/**
 * One chapter's editable source, plus its history.
 *
 * When the chapter has no uploaded source (published before AB#7420, or by a
 * custom parser that has no markdown to give), this reconstructs readable
 * markdown from the published blocks and says so with `reconstructed: true`.
 * The reconstruction is lossy by definition — it is the block model rendered
 * back out, not the author's original file — so the portal warns before the
 * first save adopts it as the new source of truth.
 */
adminContent.get('/content/books/:bookId/chapters/:chapterId', async (c) => {
  const r = resolve(c, true);
  if (r instanceof Response) return r;
  const { store, bookId, chapterId } = r;

  const manifest = await readManifest(store);
  const book = manifest ? findBook(manifest, bookId) : undefined;
  const entry = findChapter(book, chapterId);
  if (!entry) return c.json({ error: 'not_found', message: 'No such chapter in this library.' }, 404);

  const source = await getText(store, key.source(bookId, chapterId));
  const revisions = await listRevisions(store, bookId, chapterId);

  return c.json({
    bookId,
    chapterId,
    title: entry.title,
    label: entry.label,
    markdown: source ?? reconstructMarkdown(entry, await readBlocks(store, entry)),
    reconstructed: source === null,
    hasAudio: entry.hasAudio,
    audioStale: entry.audioStale === true,
    wordCount: entry.wordCount,
    readingTime: entry.readingTime,
    contentHash: entry.contentHash,
    revisions,
    revisionLimit: revisionLimit(c.env),
  });
});

/**
 * Live preview — markdown in, the blocks that would publish out.
 *
 * The editor could have parsed markdown in the browser, and that would have
 * been a THIRD implementation of the block rules alongside the pipeline's and
 * the Worker's. Instead the preview is a round trip through the same
 * `parseBlocks` the save uses, which makes the preview literally what will
 * publish rather than an approximation of it — including the validation prose,
 * so a broken front matter block is visible while typing rather than on save.
 *
 * Writes nothing and touches no manifest; it is a POST only because a chapter
 * doesn't fit in a query string.
 */
adminContent.post('/content/preview', async (c) => {
  const body = await c.req.json<{ markdown?: string }>().catch(() => null);
  if (!body || typeof body.markdown !== 'string') return c.json({ error: 'bad_request', message: 'A `markdown` string is required.' }, 400);
  const { data, body: prose } = readFrontmatter(body.markdown);
  const blocks = parseBlocks(prose);
  const meta = chapterMeta(blocks);
  return c.json({
    title: typeof data.title === 'string' ? data.title : undefined,
    label: typeof data.label === 'string' ? data.label : undefined,
    blocks,
    ...meta,
    problem: validateSource(body.markdown),
  });
});

/**
 * Save a chapter — the one operation behind all three doors plan §3 names
 * (type in the editor, paste, upload a `.md`). All three mean "replace the text
 * of this chapter", so all three are this request.
 *
 * `correction` is the flag that decides whether readers' phones ring. The
 * portal sends it explicitly; a client that omits it gets the safe answer
 * (`true` for an existing chapter, `false` for one being created), because
 * accidentally announcing a typo fix to every subscriber is the failure worth
 * defaulting against.
 */
adminContent.put('/content/books/:bookId/chapters/:chapterId', async (c) => {
  const r = resolve(c, true);
  if (r instanceof Response) return r;
  const { store, bookId, chapterId } = r;

  const body = await c.req.json<{ markdown?: string; correction?: boolean }>().catch(() => null);
  if (!body || typeof body.markdown !== 'string') {
    return c.json({ error: 'bad_request', message: 'A `markdown` string is required.' }, 400);
  }
  const problem = validateSource(body.markdown);
  if (problem) return c.json({ error: 'invalid_markdown', message: problem }, 400);

  const manifest = await readManifest(store);
  const isNew = !findChapter(manifest ? findBook(manifest, bookId) : undefined, chapterId);
  const correction = typeof body.correction === 'boolean' ? body.correction : !isNew;

  const result = await saveChapter({
    store,
    env: c.env,
    bookId,
    chapterId,
    markdown: body.markdown,
    correction,
    savedBy: actor(c),
  });
  const notified = await recordPublish(c.env, (p) => c.executionCtx.waitUntil(p), result.libraryVersion, !correction);

  return c.json({ ok: true, created: isNew, ...result, notified });
});

/** The escape hatch: the current markdown, as a file, so an author can edit it
 *  in their own tool and put it back through the same endpoint. */
adminContent.get('/content/books/:bookId/chapters/:chapterId/download', async (c) => {
  const r = resolve(c, true);
  if (r instanceof Response) return r;
  const { store, bookId, chapterId } = r;
  const manifest = await readManifest(store);
  const entry = findChapter(manifest ? findBook(manifest, bookId) : undefined, chapterId);
  if (!entry) return c.json({ error: 'not_found' }, 404);
  const source = (await getText(store, key.source(bookId, chapterId))) ?? reconstructMarkdown(entry, await readBlocks(store, entry));
  return new Response(source, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${chapterId}.md"`,
      'Cache-Control': 'no-store',
    },
  });
});

adminContent.get('/content/books/:bookId/chapters/:chapterId/revisions', async (c) => {
  const r = resolve(c, true);
  if (r instanceof Response) return r;
  return c.json({ revisions: await listRevisions(r.store, r.bookId, r.chapterId), revisionLimit: revisionLimit(c.env) });
});

adminContent.get('/content/books/:bookId/chapters/:chapterId/revisions/:revisionId', async (c) => {
  const r = resolve(c, true);
  if (r instanceof Response) return r;
  const revisionId = c.req.param('revisionId');
  if (!/^[0-9]+(-[0-9]+)?$/.test(revisionId)) return c.json({ error: 'invalid_revision_id' }, 400);
  const markdown = await readRevision(r.store, r.bookId, r.chapterId, revisionId);
  if (markdown === null) return c.json({ error: 'not_found', message: 'That revision has aged out or never existed.' }, 404);
  return c.json({ revisionId, markdown });
});

/**
 * Revert to an earlier revision.
 *
 * Deliberately NOT a special storage operation: it reads the old text and puts
 * it back through `saveChapter`, so it goes through exactly the same parse,
 * hash, chapter-JSON write and manifest rewrite an ordinary edit does. That
 * means it also appends a NEW revision rather than rewinding the list — the
 * history of what happened is preserved, including the revert itself, and the
 * revision reverted FROM is still there to go back to if the revert was the
 * mistake.
 *
 * A revert marks the narration stale for the same reason an edit does: rolling
 * the text back leaves audio matching the newer text that was just discarded.
 * Text reverts instantly; audio catches up on the next pipeline run. It
 * defaults to a correction — putting back words readers have already seen is
 * not a publication — but the caller can say otherwise.
 */
adminContent.post('/content/books/:bookId/chapters/:chapterId/revisions/:revisionId/revert', async (c) => {
  const r = resolve(c, true);
  if (r instanceof Response) return r;
  const { store, bookId, chapterId } = r;
  const revisionId = c.req.param('revisionId');
  if (!/^[0-9]+(-[0-9]+)?$/.test(revisionId)) return c.json({ error: 'invalid_revision_id' }, 400);

  const markdown = await readRevision(store, bookId, chapterId, revisionId);
  if (markdown === null) return c.json({ error: 'not_found', message: 'That revision has aged out or never existed.' }, 404);

  const body = await c.req.json<{ correction?: boolean }>().catch(() => null);
  const correction = typeof body?.correction === 'boolean' ? body.correction : true;

  const result = await saveChapter({
    store,
    env: c.env,
    bookId,
    chapterId,
    markdown,
    correction,
    savedBy: actor(c),
    revertedFrom: revisionId,
  });
  const notified = await recordPublish(c.env, (p) => c.executionCtx.waitUntil(p), result.libraryVersion, !correction);
  return c.json({ ok: true, revertedFrom: revisionId, ...result, notified });
});

/**
 * Book-level metadata — title, author, description — on the same surface as
 * the chapters, because "edit the book" and "edit a chapter in it" are the same
 * job to whoever is doing it. Always a correction: changing a description is
 * never new content.
 */
adminContent.put('/content/books/:bookId', async (c) => {
  const r = resolve(c, false);
  if (r instanceof Response) return r;
  const { store, bookId } = r;
  const body = await c.req.json<{ title?: string; author?: string; description?: string }>().catch(() => null);
  if (!body) return c.json({ error: 'bad_request' }, 400);

  const manifest = await readManifest(store);
  const book = manifest ? findBook(manifest, bookId) : undefined;
  if (!manifest || !book) return c.json({ error: 'not_found' }, 404);

  if (typeof body.title === 'string') book.title = body.title;
  if (typeof body.author === 'string') book.author = body.author;
  if (typeof body.description === 'string') book.description = body.description;
  manifest.libraryVersion = (manifest.libraryVersion ?? 0) + 1;
  (manifest as { announceVersion?: number }).announceVersion = announceVersionOf(manifest);
  manifest.generatedAt = new Date().toISOString();
  await writeManifest(store, manifest);
  await recordPublish(c.env, (p) => c.executionCtx.waitUntil(p), manifest.libraryVersion, false);

  return c.json({ ok: true, book: { id: book.id, title: book.title, author: book.author, description: book.description } });
});

/**
 * Remove a chapter from the library.
 *
 * The manifest entry goes; the content-hashed objects behind it stay. They are
 * immutable and unreferenced, they cost almost nothing, and leaving them means
 * a delete made in error is recoverable by re-saving the source — which is also
 * still there, under `books/<book>/source/`.
 */
adminContent.delete('/content/books/:bookId/chapters/:chapterId', async (c) => {
  const r = resolve(c, true);
  if (r instanceof Response) return r;
  const { store, bookId, chapterId } = r;
  const manifest = await readManifest(store);
  const book = manifest ? findBook(manifest, bookId) : undefined;
  if (!manifest || !book || !findChapter(book, chapterId)) return c.json({ error: 'not_found' }, 404);

  book.chapters = book.chapters.filter((ch) => ch.id !== chapterId);
  manifest.libraryVersion = (manifest.libraryVersion ?? 0) + 1;
  (manifest as { announceVersion?: number }).announceVersion = announceVersionOf(manifest);
  manifest.generatedAt = new Date().toISOString();
  await writeManifest(store, manifest);
  await recordPublish(c.env, (p) => c.executionCtx.waitUntil(p), manifest.libraryVersion, false);
  return c.json({ ok: true, deleted: chapterId, libraryVersion: manifest.libraryVersion });
});

/**
 * Image upload (AB#7421) — one endpoint, two jobs.
 *
 *   kind=inline → books/<book>/images/<name>-<hash>.<ext>, and the response
 *     carries the exact markdown to insert. The author never types a URL and
 *     never has to know where storage lives; the editor's "insert image" action
 *     pastes `![alt](<url>)` at the cursor.
 *   kind=cover  → books/<book>/covers/cover.<hash>.<ext>, written into the
 *     manifest's book entry. This is the same key shape publish.mjs uses, so
 *     the CLI and the portal produce interchangeable results. For a flat
 *     (many-short-stories) library the cover IS the title illustration.
 *
 * Content-hashed filenames are not decoration: these are served with immutable
 * caching, so re-uploading under a name already in a reader's cache would
 * otherwise never be seen.
 */
adminContent.post('/upload', async (c) => {
  const store = storeOf(c);
  if (!store) return c.json({ error: 'no_content_store', message: 'This deployment has no writable content storage bound.' }, 501);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'bad_request', message: 'Expected a multipart form upload.' }, 400);
  }
  // Duck-typed rather than `instanceof File`: @cloudflare/workers-types
  // declares no global `File` constructor to test against, and the Node entry's
  // FormData yields its own File class anyway. Both give the same three
  // properties, which is all this needs.
  const candidate = form.get('file');
  const file = candidate as { name?: string; type?: string; size?: number; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return c.json({ error: 'bad_request', message: 'No file was attached.' }, 400);
  }
  const fileName = typeof file.name === 'string' ? file.name : 'image';
  const fileType = typeof file.type === 'string' ? file.type : '';
  const fileSize = typeof file.size === 'number' ? file.size : 0;

  const bookId = String(form.get('bookId') ?? '');
  if (!ID_RE.test(bookId)) return c.json({ error: 'invalid_book_id', message: 'A valid bookId is required.' }, 400);
  const kind = String(form.get('kind') ?? 'inline');
  if (kind !== 'inline' && kind !== 'cover') return c.json({ error: 'bad_request', message: 'kind must be "inline" or "cover".' }, 400);

  const ext = IMAGE_TYPES[fileType];
  if (!ext) {
    return c.json(
      { error: 'unsupported_type', message: `"${fileType || 'unknown'}" isn't an image type this accepts. Use PNG, JPEG, WebP, GIF or AVIF.` },
      415
    );
  }
  const maxBytes = Number(c.env.CONTENT_MAX_UPLOAD_BYTES) || DEFAULT_MAX_UPLOAD_BYTES;
  if (fileSize > maxBytes) {
    return c.json(
      { error: 'too_large', message: `That image is ${Math.round(fileSize / 1024)}KB; the limit is ${Math.round(maxBytes / 1024)}KB.` },
      413
    );
  }

  const bytes = await file.arrayBuffer();
  // Hashed over the raw bytes (not a JSON view of them) — an 8MB image would
  // otherwise be stringified into an array of eight million numbers first.
  const hash = (await sha256Bytes(bytes)).slice(0, 12);
  const storageKey =
    kind === 'cover' ? key.cover(bookId, hash, ext) : key.image(bookId, `${slugify(fileName, ext)}-${hash}.${ext}`);
  await store.put(storageKey, bytes, { contentType: fileType, cacheControl: IMMUTABLE });

  const url = `${c.env.CONTENT_ORIGIN.replace(/\/+$/, '')}/${storageKey}`;

  if (kind === 'cover') {
    const manifest = await readManifest(store);
    const book = manifest ? findBook(manifest, bookId) : undefined;
    if (manifest && book) {
      book.cover = storageKey;
      manifest.libraryVersion = (manifest.libraryVersion ?? 0) + 1;
      (manifest as { announceVersion?: number }).announceVersion = announceVersionOf(manifest);
      manifest.generatedAt = new Date().toISOString();
      await writeManifest(store, manifest);
      await recordPublish(c.env, (p) => c.executionCtx.waitUntil(p), manifest.libraryVersion, false);
    }
  }

  const alt = String(form.get('alt') ?? '').replace(/[[\]]/g, '');
  return c.json({
    ok: true,
    kind,
    key: storageKey,
    url,
    bytes: fileSize,
    contentType: fileType,
    /** Ready to paste — the editor inserts this verbatim at the cursor. */
    markdown: kind === 'inline' ? `![${alt}](${url})` : undefined,
  });
});

/** A filename an author can still recognise, safe as a storage key. */
function slugify(name: string, ext: string): string {
  const stem = name.replace(/\.[^.]*$/, '').toLowerCase();
  const slug = stem
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `image-${ext}`;
}

async function readBlocks(store: ContentStore, entry: ChapterEntry): Promise<unknown[]> {
  const text = await getText(store, entry.content);
  if (text === null) return [];
  try {
    return (JSON.parse(text) as { blocks?: unknown[] }).blocks ?? [];
  } catch {
    return [];
  }
}

/**
 * Blocks → markdown, for chapters published before source upload existed.
 *
 * Lossy on purpose and labelled as such: the block model has already dropped
 * the author's line wrapping and any front matter beyond title/label, so this
 * is "the published text, as markdown", not "the file you wrote". It exists so
 * an operator with an older library can still fix a typo today instead of
 * waiting for a full CLI republish, and the portal warns that saving it adopts
 * this reconstruction as the new source.
 */
function reconstructMarkdown(entry: ChapterEntry, blocks: unknown[]): string {
  const parts: string[] = [];
  const front = [`title: ${entry.title ?? entry.id}`];
  if (entry.label) front.push(`label: ${entry.label}`);
  parts.push(`---\n${front.join('\n')}\n---\n`);
  for (const raw of blocks) {
    const b = raw as { type?: string; text?: string; src?: string; alt?: string; messages?: { speaker: string; time: string; text: string }[]; spans?: { start: number; end: number; style: string }[] };
    switch (b.type) {
      case 'paragraph':
        parts.push(applySpans(b.text ?? '', b.spans ?? []));
        break;
      case 'scene-break':
        parts.push('---');
        break;
      case 'display-beat':
      case 'end-marker':
        parts.push(`*${b.text ?? ''}*`);
        break;
      case 'image':
        parts.push(`![${b.alt ?? ''}](${b.src ?? ''})`);
        break;
      case 'message-block':
        parts.push((b.messages ?? []).map((m) => `> **${m.speaker} (${m.time}):** ${m.text}`).join('\n'));
        break;
      default:
        break;
    }
  }
  return parts.join('\n\n') + '\n';
}

/** Re-inserts the * / ** markers extractSpans() stripped, back-to-front so
 *  earlier offsets stay valid as later ones are edited in. */
function applySpans(text: string, spans: { start: number; end: number; style: string }[]): string {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    const mark = s.style === 'strong' ? '**' : '*';
    out = out.slice(0, s.start) + mark + out.slice(s.start, s.end) + mark + out.slice(s.end);
  }
  return out;
}
