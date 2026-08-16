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

export const MANIFEST_KEY = 'manifest.json';

/** Ids are storage keys and URL segments; keep them boring. Same rule as /publish-story. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

/** The book's recorded external source, when it has one. */
export function syncSourceOf(book: BookEntry | undefined | null): SyncSource | undefined {
  const raw = (book as { syncSource?: unknown } | undefined)?.syncSource;
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as SyncSource;
  return s.kind === 'git' || s.kind === 'feed' ? s : undefined;
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
        : 'an external source system';
  return (
    `${what} is managed externally — edit it at source. "${bookId}" is synced into this deployment from ${where}, ` +
    `so it is a copy, not the original: a change saved here would be overwritten the next time the sync runs. ` +
    `Change it there, then re-sync. (See docs/content-sync.md.)`
  );
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
 */
export function validateSource(markdown: string): string | null {
  if (markdown.length === 0) return 'The chapter is empty.';
  if (markdown.length > 2_000_000) return 'That chapter is larger than 2MB, which is past what this editor handles.';
  const opensFrontmatter = /^﻿?---\r?\n/.test(markdown);
  if (opensFrontmatter && !/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(markdown)) {
    return 'The front matter block starts with --- but never closes. Add a closing --- line.';
  }
  const { body } = readFrontmatter(markdown);
  if (parseBlocks(body).length === 0) return 'There is no text in this chapter — only front matter.';
  return null;
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
  const title = typeof data.title === 'string' ? data.title : (existing?.title ?? chapterId);
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
