/**
 * Content editing against the deployment's own storage (AB#7420 — plan §3).
 *
 * ── The blocker this closes ─────────────────────────────────────────────────
 * Publishing used to be one-way: local markdown → parse → TTS → upload →
 * manifest, with the source markdown never leaving the operator's laptop. A
 * deployment therefore had no copy of what it was built from, which is exactly
 * why there was no edit story — there was nothing for a browser to open.
 *
 * `packages/pipeline/publish.mjs` now uploads the source alongside the derived
 * artifacts, so the key space is:
 *
 *     books/<book>/source/book.json          book metadata, as authored
 *     books/<book>/source/<chapter>.md       ← the editable source of truth
 *     books/<book>/chapters/<id>.<hash>.json derived, immutable
 *     books/<book>/audio/<id>.<hash>.mp3     derived, immutable
 *     books/<book>/revisions/<chapter>/…     text history (this file)
 *     books/<book>/images/<name>             inline art
 *     books/<book>/covers/cover.<hash>.<ext> title illustration
 *     manifest.json                          the generated index the app reads
 *
 * ── What this file is NOT ───────────────────────────────────────────────────
 * It is not a second publish pipeline. It does no narration (a Worker cannot
 * run the TTS model — plan §3's "honest constraint"), no force-alignment, no
 * audio stitching and no cover derivation. What it does is the strict subset a
 * text edit needs and that has to be instant to be worth having: re-parse ONE
 * chapter, write its content JSON, rewrite the manifest entry, and mark the
 * narration stale so nobody is left wondering why the voice no longer matches
 * the words. The next pipeline run sees a changed source hash and re-narrates.
 *
 * The markdown rules themselves are not reimplemented either — `lib/md.ts`
 * carries them, and `packages/worker/test/md-parity.test.mjs` proves it agrees
 * with the pipeline's copy block for block.
 *
 * ── The manifest is generated, so every save rewrites it ────────────────────
 * The app never scans folders; it reads `manifest.json`. A text edit changes a
 * chapter's content hash, word count and reading time, so "save" here always
 * means "rewrite the manifest too" — with the chapter JSON written FIRST, the
 * same ordering rule publish.mjs follows, so a reader can never see a manifest
 * pointing at an object that isn't there yet.
 */

import type { Context } from 'hono';
import type { AppContext, Env } from '../types';
import type {
  Block,
  BookEntry,
  ChapterContent,
  ChapterEntry,
  ContentOrigin,
  LibraryManifest,
  RevisionEntry,
  RevisionIndex,
  SyncSource,
} from '../content-types';
import { DEFAULT_ORIGIN } from '../content-types';
import { getJson, getText, putJson, putText, type ContentStore } from './content-store';
import { chapterMeta, contentHash, parseBlocks, readFrontmatter, stabilizeBlockIds } from './md';
import { CONTENT_ID_RE, readStorylarkBlock, validateChapterCandidate } from 'storylark-contracts/content';

export const MANIFEST_KEY = 'manifest.json';

/** Ids are storage keys and URL segments; keep them boring. Same rule as /publish-story —
 *  and literally the same RegExp object the content contract validates with, so the
 *  routes' early id checks can never drift from the gate's. */
export const ID_RE = CONTENT_ID_RE;

/**
 * How many text revisions to keep per chapter (plan §3: five, "as a config
 * value rather than a hard-coded constant so it can be raised without a code
 * change"). `CONTENT_REVISIONS` in the deployment's environment overrides it.
 *
 * Text is tiny — a 2,000-word chapter is about 12KB — so the ceiling exists to
 * stop an accident, not to save money. Audio is never versioned: narration is
 * megabytes per chapter and always regenerable from the text.
 */
export const DEFAULT_REVISIONS = 5;

export function revisionLimit(env: Env): number {
  const raw = Number(env.CONTENT_REVISIONS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_REVISIONS;
  return Math.min(Math.floor(raw), 100);
}

export const key = {
  source: (bookId: string, chapterId: string) => `books/${bookId}/source/${chapterId}.md`,
  bookMeta: (bookId: string) => `books/${bookId}/source/book.json`,
  chapterJson: (bookId: string, chapterId: string, hash: string) => `books/${bookId}/chapters/${chapterId}.${hash}.json`,
  revisionIndex: (bookId: string, chapterId: string) => `books/${bookId}/revisions/${chapterId}/index.json`,
  revision: (bookId: string, chapterId: string, id: string) => `books/${bookId}/revisions/${chapterId}/${id}.md`,
  image: (bookId: string, name: string) => `books/${bookId}/images/${name}`,
  cover: (bookId: string, hash: string, ext: string) => `books/${bookId}/covers/cover.${hash}.${ext}`,
};

/**
 * This deployment's content store, or null when it has none.
 *
 * Cloudflare binds it from the CONTENT R2 bucket in index.ts; the Node entry
 * binds an Azure Blob or local-directory driver in platforms/azure/server.mjs.
 * A deployment without one still serves and still reads content over its public
 * origin — it just can't be edited from the browser, and every route here says
 * so plainly instead of failing in a confusing way.
 */
export function storeOf(c: Context<AppContext>): ContentStore | null {
  return c.env.CONTENT_STORE ?? null;
}

export async function readManifest(store: ContentStore): Promise<LibraryManifest | null> {
  return getJson<LibraryManifest>(store, MANIFEST_KEY);
}

/** The manifest is the one key written with a SHORT TTL — everything else is content-hashed. */
export async function writeManifest(store: ContentStore, manifest: LibraryManifest): Promise<void> {
  await putJson(store, MANIFEST_KEY, manifest, false);
}

export function findBook(manifest: LibraryManifest, bookId: string): BookEntry | undefined {
  return manifest.books?.find((b) => b.id === bookId);
}

export function findChapter(book: BookEntry | undefined, chapterId: string): ChapterEntry | undefined {
  return book?.chapters?.find((ch) => ch.id === chapterId);
}

/**
 * The version readers are told about, as distinct from the version that makes
 * them re-fetch.
 *
 * `libraryVersion` always moves on any change — it is the manifest's own
 * revision counter and the value `/api/library/version` is compared against.
 * `announceVersion` moves only for a genuine publication, and it is what the
 * app's "new content" badge compares against. A manifest written by a pipeline
 * that predates this field has no `announceVersion`, and the app falls back to
 * `libraryVersion`, i.e. exactly the old behaviour.
 */
export function announceVersionOf(manifest: LibraryManifest): number {
  const v = (manifest as { announceVersion?: unknown }).announceVersion;
  return typeof v === 'number' ? v : manifest.libraryVersion;
}

/* ── Ownership: where content came from, and who therefore owns its edit button
 * ───────────────────────────────────────────────────────────────────────────
 * Plan §8's one rule. Everything below is deliberately small and in one place,
 * because it is the difference between "a synced library is safe" and "a synced
 * library silently diverges from the repo that owns it".
 */

const ORIGINS: ReadonlySet<string> = new Set<ContentOrigin>(['portal', 'cli', 'sync', 'personal']);

/**
 * The origin of a book or chapter entry, defaulting an absent (or nonsense)
 * value to `cli`.
 *
 * The default is load-bearing and it is deliberately the WRITABLE one: every
 * manifest written before this field existed came from the pipeline, and an
 * older library must not become uneditable because it predates a field. An
 * unrecognised value — a newer pipeline writing an origin this Worker has never
 * heard of — also lands on `cli` rather than being treated as read-only, for
 * the same reason: refusing to let an operator fix a typo is a worse failure
 * than mislabelling where the text came from.
 */
export function originOf(entry: { origin?: unknown } | undefined | null): ContentOrigin {
  const raw = entry?.origin;
  return typeof raw === 'string' && ORIGINS.has(raw) ? (raw as ContentOrigin) : DEFAULT_ORIGIN;
}

/**
 * Content that arrived from an external source of truth is read-only HERE.
 *
 * Exactly one origin is read-only, and it is stated as an explicit list rather
 * than "anything that isn't portal" so that adding a future origin cannot
 * accidentally lock a library.
 */
export function isManagedExternally(entry: { origin?: unknown } | undefined | null): boolean {
  return originOf(entry) === 'sync';
}

/**
 * A chapter's effective origin: its own if it states one, otherwise its book's.
 *
 * Chapters carry the field too (that is what a write is checked against), but a
 * book synced as a whole is the normal case, and a chapter added to a manifest
 * by an older writer would have no origin of its own. Inheriting from the book
 * means a synced catalogue is protected as a unit without every entry having to
 * repeat itself.
 */
export function effectiveOrigin(
  book: { origin?: unknown } | undefined | null,
  chapter: { origin?: unknown } | undefined | null
): ContentOrigin {
  if (chapter && chapter.origin !== undefined) return originOf(chapter);
  return originOf(book);
}

/**
 * The book's recorded external source, when it has one.
 *
 * Three kinds, and the list is closed: `git` and `feed` are the two PULL
 * connectors (`packages/pipeline/sync.mjs`, and plan §8's hard scope line says
 * there will never be a third of those), `api` means the publisher's own system
 * pushed this in over the content API. Anything else — a manifest written by a
 * newer engine, or a hand-edited one — reads as "no recorded source", which
 * degrades to the generic refusal message rather than trusting a shape this
 * code cannot describe.
 */
export function syncSourceOf(book: BookEntry | undefined | null): SyncSource | undefined {
  const raw = (book as { syncSource?: unknown } | undefined)?.syncSource;
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as SyncSource;
  return s.kind === 'git' || s.kind === 'feed' || s.kind === 'api' ? s : undefined;
}

/**
 * True when this book is owned by one of the two PULL connectors.
 *
 * The distinction matters to exactly one caller: the content API
 * (routes/content-api.ts). A pushing system owns `api` content and must be able
 * to update it — that is the whole point of the push contract — but it must NOT
 * be able to overwrite a book whose source of truth is a git repo or a feed,
 * because the next `sync.mjs` run would silently revert the push and the two
 * systems would fight. The admin portal refuses ALL of them, because a human
 * typing in the portal owns none of them.
 */
export function isPullManaged(book: BookEntry | undefined | null): boolean {
  const kind = syncSourceOf(book)?.kind;
  return originOf(book) === 'sync' && (kind === 'git' || kind === 'feed');
}

/**
 * The refusal, in the words plan §8 asks for.
 *
 * Not a bare 403: an operator staring at a chapter they can see but cannot save
 * needs to know WHY and WHERE the edit belongs instead, or they will assume the
 * portal is broken and go looking for a permissions bug that isn't there.
 */
export function managedExternallyMessage(bookId: string, source: SyncSource | undefined, what: string): string {
  const where =
    source?.kind === 'git'
      ? `the git repository ${source.url}${source.ref ? ` (branch ${source.ref})` : ''}`
      : source?.kind === 'feed'
        ? `the system that publishes ${source.url}`
        : source?.kind === 'api'
          ? `${source.system ? `${source.system}` : 'an external system'}${source.url ? `, at ${source.url}` : ''}, which pushes it in over the content API`
          : 'an external source system';
  const howItComesBack =
    source?.kind === 'api'
      ? `a change saved here would be overwritten the next time that system pushes. Change it there, and it arrives on the next push. (See docs/content-api.md.)`
      : `a change saved here would be overwritten the next time the sync runs. Change it there, then re-sync. (See docs/content-sync.md.)`;
  return (
    `${what} is managed externally — edit it at source. "${bookId}" is synced into this deployment from ${where}, ` +
    `so it is a copy, not the original: ${howItComesBack}`
  );
}

/* ── Chapter order (AB#7412 — plan §3: "Chapter management — add, reorder,
 * delete") ──────────────────────────────────────────────────────────────────
 *
 * There is no position field to update, and there deliberately isn't one: the
 * ORDER OF `book.chapters` IS the chapter order. The app reads the manifest and
 * renders that array as it stands, `publish.mjs` builds it from the numeric
 * filename prefixes, and every reader of it — the reader UI, the next/previous
 * links, the downloads list — already agrees on that. Adding an `index` field
 * would create a second answer to the same question and guarantee they diverge.
 *
 * So reordering is a permutation of one array, and the only thing worth being
 * careful about is that it stays a PERMUTATION.
 */
export function reorderChapters(
  chapters: ChapterEntry[],
  order: string[]
): { ok: true; chapters: ChapterEntry[] } | { ok: false; message: string } {
  const current = chapters.map((ch) => ch.id);
  if (order.length !== current.length) {
    return {
      ok: false,
      message:
        `That order lists ${order.length} chapter(s) but the book has ${current.length}. ` +
        `Reload the book — it changed since this page was opened.`,
    };
  }
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) return { ok: false, message: `"${id}" appears more than once in the requested order.` };
    seen.add(id);
  }
  const byId = new Map(chapters.map((ch) => [ch.id, ch]));
  const missing = order.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `The requested order names chapter(s) this book doesn't have: ${missing.join(', ')}. ` +
        `Reload the book — it changed since this page was opened.`,
    };
  }
  // Reject by construction rather than by silently dropping: a reorder that
  // omitted a chapter would DELETE it, and a stale browser tab must not be able
  // to delete a chapter it simply hadn't heard of yet.
  const dropped = current.filter((id) => !seen.has(id));
  if (dropped.length > 0) {
    return {
      ok: false,
      message: `The requested order leaves out ${dropped.join(', ')}. Reordering never removes a chapter; reload the book and try again.`,
    };
  }
  return { ok: true, chapters: order.map((id) => byId.get(id) as ChapterEntry) };
}

/**
 * Conflict detection, portal side (AB#7412 — plan §3's last open item).
 *
 * The editor opened a chapter at some `contentHash` and the operator then typed
 * for a while. If a `publish.mjs` run — or another browser tab — landed in that
 * window, the live chapter is no longer the one being edited, and saving would
 * overwrite work this session never saw.
 *
 * The check reuses the metadata that already exists rather than inventing a
 * lock: `contentHash` is on every manifest entry, it is what the editor is
 * handed when it loads, and it changes on every save from either side. No
 * timestamps (clock skew), no version column (a schema change), no lease (a
 * deployment that can be closed mid-edit).
 *
 * A caller that sends no base hash is unchanged — this is opt-in per request,
 * so the CLI, the content API and any older portal bundle keep working exactly
 * as before.
 */
export function detectSaveConflict(
  existing: ChapterEntry | undefined,
  baseContentHash: string | undefined
): { conflict: true; liveContentHash: string; message: string } | null {
  if (!baseContentHash || !existing) return null;
  if (existing.contentHash === baseContentHash) return null;
  return {
    conflict: true,
    liveContentHash: existing.contentHash,
    message:
      `This chapter changed after you opened it — someone else saved it, or a \`publish\` run landed. ` +
      `You are editing version ${baseContentHash}; the live version is ${existing.contentHash}. ` +
      `Saving now would discard that newer text. Reload to see it (your draft is still in the editor and can be downloaded first), ` +
      `or save anyway if yours is the version that should win.`,
  };
}

export interface SaveResult {
  bookId: string;
  chapterId: string;
  contentHash: string;
  wordCount: number;
  readingTime: string;
  blocks: number;
  /** True when the chapter has narration that no longer matches the text. */
  audioStale: boolean;
  libraryVersion: number;
  announceVersion: number;
  correction: boolean;
  revision: RevisionEntry;
  revisionCount: number;
}

export interface SaveOptions {
  bookId: string;
  chapterId: string;
  markdown: string;
  /**
   * "This is a correction." Suppresses the announcement — no push fan-out, no
   * in-app new-content badge — while still delivering the new text. Defaults
   * are decided by the caller, not here: the portal defaults it ON for an edit
   * to existing content and OFF for a chapter that didn't exist yet, which is
   * the rule plan §3 asks for.
   */
  correction: boolean;
  savedBy: string;
  /** Set when this save is the result of reverting to an earlier revision. */
  revertedFrom?: string;
  /**
   * Where this text came from (AB#7422). Omitted, an existing chapter KEEPS the
   * origin it already had and a new one is `portal` — because a portal edit to
   * a CLI-published chapter does not change where that chapter came from, it
   * just means the deployment now holds the newer copy (which is exactly what
   * `publish.mjs --pull` exists to reconcile). Callers never pass `sync` here:
   * synced content is refused by the routes before it reaches this function.
   */
  origin?: ContentOrigin;
  store: ContentStore;
  env: Env;
}

/**
 * Validation that runs BEFORE anything is written (plan §3: "malformed markdown
 * or broken front matter is reported before publishing, not discovered after").
 * Returns a human-readable problem, or null when the source is publishable.
 *
 * Since the content-management rework this is a thin veneer over the ONE
 * validator (`storylark-contracts/content`) — the same gate the content API and
 * the repo sync use, so a file the portal's preview calls fine can never be a
 * file the API refuses. Callers that want the structured error list (stable
 * code + line) call `validateChapterCandidate` directly; this keeps the
 * one-string shape the preview endpoint already speaks.
 */
export function validateSource(markdown: string): string | null {
  const result = validateChapterCandidate({ markdown });
  return result.ok ? null : result.errors[0].message;
}

/**
 * Save one chapter's source and republish just that chapter.
 *
 * Order matters and matches the pipeline's: derived object first, manifest
 * last. Between those two the source and the revision history are written,
 * because losing either of those to a mid-flight failure is worse than a
 * moment where storage holds a chapter JSON no manifest references yet (that
 * object is content-hashed and simply unreferenced, which is harmless).
 */
export async function saveChapter(opts: SaveOptions): Promise<SaveResult> {
  const { store, env, bookId, chapterId, markdown, correction, savedBy } = opts;

  const manifest = (await readManifest(store)) ?? {
    schemaVersion: 1,
    libraryVersion: 0,
    generatedAt: new Date().toISOString(),
    books: [],
  };
  let book = findBook(manifest, bookId);
  if (!book) {
    // A book that first appears through a portal save is portal-owned. A synced
    // book never reaches here — the routes refuse before this point — so this
    // can't quietly re-label somebody else's catalogue.
    book = { id: bookId, title: bookId, chapters: [], origin: opts.origin ?? 'portal' };
    manifest.books = [...(manifest.books ?? []), book];
  }
  const existing = findChapter(book, chapterId);

  // Previous blocks, so block ids survive the edit and every reader's saved
  // place in the chapter survives with them.
  const previous = existing
    ? (await getJson<ChapterContent>(store, existing.content))?.blocks
    : undefined;

  const { data, body } = readFrontmatter(markdown);
  const blocks: Block[] = await stabilizeBlockIds(parseBlocks(body), previous);
  const meta = chapterMeta(blocks);
  // Title precedence per the content contract: `storylark.title` overrides the
  // top-level `title`. Content without a `storylark:` block (all pre-contract
  // content) behaves exactly as before.
  const declared = readStorylarkBlock(markdown);
  const declaredTitle =
    declared.present && typeof declared.fields.title === 'string' && declared.fields.title.trim() !== ''
      ? declared.fields.title
      : undefined;
  const title = declaredTitle ?? (typeof data.title === 'string' ? data.title : (existing?.title ?? chapterId));
  const label = typeof data.label === 'string' ? data.label : (existing?.label ?? 'Chapter');
  const hash = await contentHash({ blocks, title });

  const chapterJson: ChapterContent = {
    id: chapterId,
    bookId,
    title,
    label,
    blocks,
    charLength: meta.charLength,
  };

  // 1. The derived object, content-hashed and immutable.
  await putJson(store, key.chapterJson(bookId, chapterId, hash), chapterJson);

  // 2. The source of truth.
  await putText(store, key.source(bookId, chapterId), markdown);

  // 3. History.
  const revision = await pushRevision({
    store,
    env,
    bookId,
    chapterId,
    markdown,
    savedBy,
    correction,
    revertedFrom: opts.revertedFrom,
    /** Seeded from whatever was live before this save, so the first portal edit
     *  to a CLI-published chapter is still revertable. */
    priorSource: existing ? await getText(store, key.source(bookId, chapterId)) : null,
  });
  const index = (await getJson<RevisionIndex>(store, key.revisionIndex(bookId, chapterId))) ?? {
    schemaVersion: 1,
    revisions: [],
  };

  // 4. The manifest, last. Unknown fields on the entry are carried through:
  //    an edit must never drop metadata a newer pipeline wrote.
  const audioStale = !!existing?.hasAudio;
  const entry: ChapterEntry = {
    ...(existing ?? {}),
    id: chapterId,
    title,
    label,
    wordCount: meta.wordCount,
    readingTime: meta.readingTime,
    contentHash: hash,
    content: key.chapterJson(bookId, chapterId, hash),
    // Recorded on the entry so the portal's listing knows a chapter is
    // round-trippable as markdown without a storage read per chapter — the
    // difference between one GET and two hundred on a many-stories library.
    source: key.source(bookId, chapterId),
    hasAudio: existing?.hasAudio ?? false,
    audioDurationMs: existing?.audioDurationMs ?? 0,
    publishedAt: existing?.publishedAt ?? new Date().toISOString().slice(0, 10),
    audioStale,
    origin: opts.origin ?? (existing ? originOf(existing) : 'portal'),
  };
  book.chapters = existing
    ? book.chapters.map((ch) => (ch.id === chapterId ? entry : ch))
    : [...(book.chapters ?? []), entry];

  const libraryVersion = (manifest.libraryVersion ?? 0) + 1;
  const announceVersion = correction ? announceVersionOf(manifest) : libraryVersion;
  manifest.libraryVersion = libraryVersion;
  (manifest as { announceVersion?: number }).announceVersion = announceVersion;
  manifest.generatedAt = new Date().toISOString();
  await writeManifest(store, manifest);

  return {
    bookId,
    chapterId,
    contentHash: hash,
    wordCount: meta.wordCount,
    readingTime: meta.readingTime,
    blocks: blocks.length,
    audioStale,
    libraryVersion,
    announceVersion,
    correction,
    revision,
    revisionCount: index.revisions.length,
  };
}

interface PushRevisionArgs {
  store: ContentStore;
  env: Env;
  bookId: string;
  chapterId: string;
  markdown: string;
  savedBy: string;
  correction: boolean;
  revertedFrom?: string;
  priorSource: string | null;
}

/**
 * Append a revision, seeding history from the pre-edit source when there isn't
 * any yet, then prune to the configured limit.
 *
 * The seed matters: without it, the very first portal edit to a chapter the CLI
 * published would have nothing to revert TO — the safety net would arrive one
 * edit too late, which is precisely when it's wanted.
 *
 * Pruning never removes the live revision. That is belt and braces (the live
 * one is always the newest, so age can't reach it), but it is written as an
 * explicit rule because reverting re-points what "live" means, and a future
 * change to that ordering must not be able to quietly delete the only copy of
 * what readers are currently being served.
 */
async function pushRevision(args: PushRevisionArgs): Promise<RevisionEntry> {
  const { store, env, bookId, chapterId, markdown, savedBy, correction } = args;
  const indexKey = key.revisionIndex(bookId, chapterId);
  const index = (await getJson<RevisionIndex>(store, indexKey)) ?? { schemaVersion: 1 as const, revisions: [] };

  if (index.revisions.length === 0 && args.priorSource && args.priorSource !== markdown) {
    const seedId = revisionId(index.revisions);
    await putText(store, key.revision(bookId, chapterId, seedId), args.priorSource, true);
    index.revisions.push({
      id: seedId,
      savedAt: Date.now() - 1,
      savedBy: 'published',
      bytes: byteLength(args.priorSource),
      live: false,
      correction: false,
    });
  }

  const id = revisionId(index.revisions);
  const entry: RevisionEntry = {
    id,
    savedAt: Date.now(),
    savedBy,
    bytes: byteLength(markdown),
    live: true,
    correction,
    ...(args.revertedFrom ? { revertedFrom: args.revertedFrom } : {}),
  };
  await putText(store, key.revision(bookId, chapterId, id), markdown, true);
  for (const r of index.revisions) r.live = false;
  index.revisions.push(entry);

  const limit = revisionLimit(env);
  while (index.revisions.length > limit) {
    const victim = index.revisions.find((r) => !r.live);
    if (!victim) break; // only the live one left — pinned, never aged out
    index.revisions.splice(index.revisions.indexOf(victim), 1);
    await store.delete(key.revision(bookId, chapterId, victim.id));
  }

  await putJson(store, indexKey, index, false);
  return entry;
}

/** Sortable, collision-free within a millisecond. */
function revisionId(existing: RevisionEntry[]): string {
  let candidate = String(Date.now());
  let n = 0;
  while (existing.some((r) => r.id === candidate)) candidate = `${Date.now()}-${++n}`;
  return candidate;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export async function listRevisions(store: ContentStore, bookId: string, chapterId: string): Promise<RevisionEntry[]> {
  const index = await getJson<RevisionIndex>(store, key.revisionIndex(bookId, chapterId));
  return (index?.revisions ?? []).slice().sort((a, b) => b.savedAt - a.savedAt);
}

export async function readRevision(
  store: ContentStore,
  bookId: string,
  chapterId: string,
  revisionId: string
): Promise<string | null> {
  return getText(store, key.revision(bookId, chapterId, revisionId));
}
