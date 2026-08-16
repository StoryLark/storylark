/**
 * The content API — StoryLark's documented, versioned PUSH contract
 * (AB#7412 — plan §8, item 1: "Push API — they call us").
 *
 * ── What this is, and what it deliberately is not ───────────────────────────
 * There were already two ways content got INTO a deployment, and both of them
 * are StoryLark reaching out or an operator running a command:
 *
 *   • `packages/pipeline/publish.mjs` — the CLI, from an operator's own markdown.
 *   • `packages/pipeline/sync.mjs`    — the two PULL connectors, git and feed.
 *
 * What did not exist was the third door plan §8 names first: a publisher's own
 * system calling US when they publish. Not a connector — a contract. They write
 * one hook into their existing release process, against a version they can pin,
 * and StoryLark writes nothing per-customer, ever. That is the same rule the
 * "exactly two pull connectors, no bespoke ones" scope line exists to protect:
 * this endpoint is what the refusal points AT.
 *
 * It is not a second publish pipeline and it is not a second content model. Every
 * write here lands in `saveChapter()` — the same function the admin portal's
 * editor calls — so the parse, the block-id stabilisation, the content hash, the
 * revision history, the manifest rewrite and the ordering rule are shared, not
 * agreed. There is no path in this file that writes storage itself.
 *
 * ── Versioned, because a third party pins against it ────────────────────────
 * `contractVersion` is required on every request body and is stated on every
 * response, following the same rule `packages/contracts/validate.mjs` already
 * applies to brand/presentation/deployment files:
 *
 *   • Additive, backwards-compatible fields do NOT move the version. A caller
 *     writing v1 keeps working; new keys are optional by construction.
 *   • Unknown keys in a request are IGNORED rather than rejected, so a caller
 *     written against a newer minor contract still succeeds against an older
 *     deployment instead of failing on a field that deployment does not read.
 *   • The version moves only on a genuinely breaking reshape, and
 *     MIN_SUPPORTED_CONTENT_API_VERSION then says how far back this engine
 *     still reads.
 *
 * A missing `contractVersion` is a hard 400. That is deliberate friction: it is
 * the one field that makes the contract a contract, and a caller that never
 * states which version it wrote against is a caller nobody can safely change
 * anything for.
 */

import type { Env } from '../types';
import type { BookEntry, ContentOrigin, LibraryManifest, SyncSource } from '../content-types';
import type { ContentStore } from './content-store';
import {
  ID_RE,
  announceVersionOf,
  findBook,
  findChapter,
  isPullManaged,
  managedExternallyMessage,
  readManifest,
  saveChapter,
  syncSourceOf,
  validateSource,
  writeManifest,
} from './content';

/** Highest content-API major this deployment understands. */
export const CONTENT_API_VERSION = 1;
/** Lowest content-API major this deployment still accepts. */
export const MIN_SUPPORTED_CONTENT_API_VERSION = 1;

/**
 * Ceilings, stated in the contract rather than discovered by a caller whose
 * 400-book onboarding push timed out halfway.
 *
 * These are per REQUEST, not per deployment: a catalogue larger than this is
 * pushed in several batches, which is what a paginating integration does
 * anyway. They are generous enough that the realistic onboarding case — a few
 * hundred short stories — fits in one call, and small enough that a single
 * request cannot run a Worker out of CPU time or memory.
 */
export const CONTENT_API_LIMITS = {
  maxBooksPerRequest: 200,
  maxChaptersPerRequest: 2000,
  /** Same ceiling `validateSource()` enforces per chapter. */
  maxChapterBytes: 2_000_000,
  /** A zip import: the archive itself, and what it may expand to. */
  maxImportBytes: 64 * 1024 * 1024,
  maxImportEntries: 4096,
} as const;

export class ContentApiError extends Error {
  readonly code: string;
  readonly status: 400 | 409 | 413 | 422;
  constructor(code: string, message: string, status: 400 | 409 | 413 | 422 = 400) {
    super(message);
    this.name = 'ContentApiError';
    this.code = code;
    this.status = status;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The wire shapes
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ChapterPush {
  id: string;
  /** The chapter, as markdown with front matter — the same text the CLI reads off disk. */
  markdown: string;
  /** Suppress the push fan-out for this one chapter. See the correction rule in docs/api.md. */
  correction?: boolean;
}

export interface BookPush {
  id: string;
  title?: string;
  author?: string;
  description?: string;
  /** Storage key or absolute URL of cover art already uploaded elsewhere. */
  cover?: string;
  chapters?: ChapterPush[];
  /**
   * "My system owns this content; make it read-only in the portal."
   *
   * Default TRUE, and the default is the load-bearing part. Plan §8's rule is
   * *whoever owns the content owns the edit button*, and a system that pushes on
   * every release owns it: an operator editing that book in the portal would see
   * their words vanish on the next push, which is exactly the divergent-copy
   * failure the ownership model exists to prevent. A caller that genuinely wants
   * the portal to stay editable — an operator's own scripting against their own
   * library — sets it to false and gets `origin: portal`.
   */
  managed?: boolean;
  /** Where the original lives, so the portal's refusal can name it. Never a credential. */
  source?: { url?: string; system?: string };
  /**
   * Remove chapters this push did not mention. Default FALSE: a push that
   * carries one corrected chapter must not be read as "the book now has one
   * chapter". A caller doing a full-catalogue replace opts in explicitly.
   */
  replaceChapters?: boolean;
}

export type BatchPolicy = 'best-effort' | 'all-or-nothing';

export interface ChapterResult {
  chapterId: string;
  ok: boolean;
  created?: boolean;
  contentHash?: string;
  wordCount?: number;
  audioStale?: boolean;
  error?: string;
  message?: string;
}

export interface BookResult {
  bookId: string;
  ok: boolean;
  created?: boolean;
  chapters: ChapterResult[];
  removed?: string[];
  error?: string;
  message?: string;
}

export interface PushOutcome {
  results: BookResult[];
  libraryVersion: number;
  announceVersion: number;
  /** Chapters actually written — the number a narration batch is sized from. */
  written: { bookId: string; chapterId: string; contentHash: string; charLength: number }[];
  summary: {
    books: number;
    booksSucceeded: number;
    booksFailed: number;
    chapters: number;
    chaptersSucceeded: number;
    chaptersFailed: number;
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Request validation — everything that can be judged without touching storage
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The one hard gate, in the same shape `validate()` applies to contract files.
 * Throws rather than returning, because there is nothing useful a caller can do
 * with a half-accepted request.
 */
export function assertContractVersion(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ContentApiError('bad_request', 'The request body must be a JSON object.');
  }
  const version = (body as { contractVersion?: unknown }).contractVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new ContentApiError(
      'contract_version_required',
      `Every content-API request must state an integer \`contractVersion\`. This deployment speaks ${MIN_SUPPORTED_CONTENT_API_VERSION}-${CONTENT_API_VERSION}; send \`"contractVersion": ${CONTENT_API_VERSION}\`. See docs/content-api.md.`
    );
  }
  if (version > CONTENT_API_VERSION) {
    throw new ContentApiError(
      'contract_version_unsupported',
      `contractVersion ${version} was written for a newer StoryLark engine (this deployment reads up to ${CONTENT_API_VERSION}). Update the deployment, or send ${CONTENT_API_VERSION}.`
    );
  }
  if (version < MIN_SUPPORTED_CONTENT_API_VERSION) {
    throw new ContentApiError(
      'contract_version_unsupported',
      `contractVersion ${version} is no longer accepted (this deployment reads ${MIN_SUPPORTED_CONTENT_API_VERSION} and up).`
    );
  }
}

/**
 * Normalise one book from the wire, rejecting anything unusable BEFORE a single
 * byte is written. Unknown keys are dropped silently — see the versioning note
 * at the top of this file.
 */
export function readBookPush(raw: unknown, where: string): BookPush {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContentApiError('bad_request', `${where}: expected a JSON object describing a book.`);
  }
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? '');
  if (!ID_RE.test(id)) {
    throw new ContentApiError(
      'invalid_book_id',
      `${where}: "${id}" is not a usable book id. Ids are 1-64 characters of lowercase letters, digits or hyphens, starting with a letter or digit — they are storage keys and URL segments.`
    );
  }
  const chaptersRaw = o.chapters;
  const chapters: ChapterPush[] = [];
  if (chaptersRaw !== undefined) {
    if (!Array.isArray(chaptersRaw)) {
      throw new ContentApiError('bad_request', `${where}: \`chapters\` must be an array.`);
    }
    for (const [i, c] of chaptersRaw.entries()) {
      chapters.push(readChapterPush(c, `${where}.chapters[${i}]`, id));
    }
    const seen = new Set<string>();
    for (const c of chapters) {
      if (seen.has(c.id)) {
        throw new ContentApiError('duplicate_chapter', `${where}: chapter "${c.id}" appears twice in the same push.`);
      }
      seen.add(c.id);
    }
  }
  return {
    id,
    title: optionalString(o.title),
    author: optionalString(o.author),
    description: optionalString(o.description),
    cover: optionalString(o.cover),
    chapters,
    managed: o.managed === undefined ? true : o.managed === true,
    source:
      o.source && typeof o.source === 'object' && !Array.isArray(o.source)
        ? {
            url: optionalString((o.source as Record<string, unknown>).url),
            system: optionalString((o.source as Record<string, unknown>).system),
          }
        : undefined,
    replaceChapters: o.replaceChapters === true,
  };
}

export function readChapterPush(raw: unknown, where: string, bookId: string): ChapterPush {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContentApiError('bad_request', `${where}: expected a JSON object describing a chapter.`);
  }
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? '');
  if (!ID_RE.test(id)) {
    throw new ContentApiError(
      'invalid_chapter_id',
      `${where}: "${id}" is not a usable chapter id in book "${bookId}". Ids are 1-64 characters of lowercase letters, digits or hyphens.`
    );
  }
  if (typeof o.markdown !== 'string') {
    throw new ContentApiError('bad_request', `${where}: \`markdown\` must be a string.`);
  }
  if (o.markdown.length > CONTENT_API_LIMITS.maxChapterBytes) {
    throw new ContentApiError(
      'too_large',
      `${where}: that chapter is larger than ${Math.round(CONTENT_API_LIMITS.maxChapterBytes / 1024)}KB.`,
      413
    );
  }
  return { id, markdown: o.markdown, correction: o.correction === true ? true : o.correction === false ? false : undefined };
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function readPolicy(raw: unknown): BatchPolicy {
  if (raw === undefined || raw === 'best-effort') return 'best-effort';
  if (raw === 'all-or-nothing') return 'all-or-nothing';
  throw new ContentApiError('bad_request', '`policy` must be "best-effort" (the default) or "all-or-nothing".');
}

/* ────────────────────────────────────────────────────────────────────────────
 * The push itself
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PushOptions {
  store: ContentStore;
  env: Env;
  books: BookPush[];
  policy: BatchPolicy;
  /** Who to record on the revision — the API caller, not a person. */
  actor: string;
  /** Default `correction` for chapters that don't state one. */
  correction?: boolean;
}

/**
 * Push one or many books, with an explicit, documented failure policy.
 *
 * ── The policy decision, and why ────────────────────────────────────────────
 * **`best-effort` is the default.** Plan §8's own words for the bulk case are
 * "one bad book in a batch of 50 shouldn't silently corrupt or block the other
 * 49", and an onboarding import is exactly where a single malformed file is
 * most likely: it is the first time anybody has run this catalogue through
 * StoryLark's parser. Refusing all fifty because of one would mean the operator
 * fixes one file, re-uploads fifty, and discovers the *second* bad one. Books
 * are independent units — each is its own manifest entry and its own set of
 * storage keys — so partial success is a coherent state, not a corrupt one, and
 * the per-item report says exactly which book failed and why.
 *
 * **`all-or-nothing` is available and is honest about its limit.** It runs the
 * full validation pass over every book and chapter first and writes nothing at
 * all if anything fails — which covers every failure a caller can actually
 * cause (bad ids, broken front matter, empty chapters, an oversized file, a
 * book owned by a pull connector). What it CANNOT do is roll back a write that
 * already succeeded when storage fails halfway through: the content store is
 * object storage with no transaction, and pretending otherwise would be worse
 * than saying so. A storage failure mid-batch therefore leaves the books
 * written so far written, and the response reports precisely which those were.
 *
 * Either way the manifest is only ever advanced by `saveChapter()`, one chapter
 * at a time, in the order the pipeline uses: derived object first, manifest
 * last. A reader never sees a manifest pointing at an object that isn't there.
 */
export async function pushBooks(opts: PushOptions): Promise<PushOutcome> {
  const { store, env, books, policy, actor } = opts;

  if (books.length === 0) {
    throw new ContentApiError('bad_request', 'Nothing to push: `books` is empty.');
  }
  if (books.length > CONTENT_API_LIMITS.maxBooksPerRequest) {
    throw new ContentApiError(
      'too_large',
      `This push carries ${books.length} books; the per-request limit is ${CONTENT_API_LIMITS.maxBooksPerRequest}. Split it into several requests — each is independent.`,
      413
    );
  }
  const chapterCount = books.reduce((n, b) => n + (b.chapters?.length ?? 0), 0);
  if (chapterCount > CONTENT_API_LIMITS.maxChaptersPerRequest) {
    throw new ContentApiError(
      'too_large',
      `This push carries ${chapterCount} chapters; the per-request limit is ${CONTENT_API_LIMITS.maxChaptersPerRequest}.`,
      413
    );
  }

  // ── Pass 1: judge everything, write nothing. ────────────────────────────
  // Runs for BOTH policies. Under all-or-nothing it is the gate; under
  // best-effort it is what lets a book be reported as failed without its first
  // three chapters having already landed.
  const manifest = await readManifest(store);
  const problems = new Map<string, { error: string; message: string }>();
  for (const book of books) {
    const existing = manifest ? findBook(manifest, book.id) : undefined;
    if (isPullManaged(existing)) {
      const source = syncSourceOf(existing);
      problems.set(book.id, {
        error: 'managed_externally',
        message: managedExternallyMessage(book.id, source, `"${book.id}"`),
      });
      continue;
    }
    for (const chapter of book.chapters ?? []) {
      const problem = validateSource(chapter.markdown);
      if (problem) {
        problems.set(book.id, {
          error: 'invalid_markdown',
          message: `${book.id}/${chapter.id}: ${problem}`,
        });
        break;
      }
    }
  }

  if (policy === 'all-or-nothing' && problems.size > 0) {
    const first = [...problems.entries()][0];
    throw new ContentApiError(
      'batch_rejected',
      `Nothing was written. ${problems.size} of ${books.length} book(s) failed validation and the policy is all-or-nothing — first problem: ${first[1].message}`,
      422
    );
  }

  // ── Pass 2: write. ──────────────────────────────────────────────────────
  const results: BookResult[] = [];
  const written: PushOutcome['written'] = [];
  let libraryVersion = manifest?.libraryVersion ?? 0;
  let announceVersion = manifest ? announceVersionOf(manifest) : 0;

  for (const book of books) {
    const failed = problems.get(book.id);
    if (failed) {
      results.push({ bookId: book.id, ok: false, chapters: [], ...failed });
      continue;
    }
    try {
      const result = await pushOneBook({ store, env, book, actor, correction: opts.correction });
      results.push(result.book);
      written.push(...result.written);
      libraryVersion = result.libraryVersion;
      announceVersion = result.announceVersion;
    } catch (err) {
      // A storage failure. Reported per book, never swallowed, and never
      // claimed to have been rolled back — see the policy note above.
      results.push({
        bookId: book.id,
        ok: false,
        chapters: [],
        error: 'write_failed',
        message: `${book.id}: ${(err as Error).message}`,
      });
      if (policy === 'all-or-nothing') break;
    }
  }

  const chaptersSucceeded = results.reduce((n, r) => n + r.chapters.filter((c) => c.ok).length, 0);
  const chaptersFailed = results.reduce((n, r) => n + r.chapters.filter((c) => !c.ok).length, 0);
  return {
    results,
    libraryVersion,
    announceVersion,
    written,
    summary: {
      books: books.length,
      booksSucceeded: results.filter((r) => r.ok).length,
      booksFailed: results.filter((r) => !r.ok).length,
      chapters: chapterCount,
      chaptersSucceeded,
      chaptersFailed,
    },
  };
}

interface OneBookArgs {
  store: ContentStore;
  env: Env;
  book: BookPush;
  actor: string;
  correction?: boolean;
}

async function pushOneBook(args: OneBookArgs): Promise<{
  book: BookResult;
  written: PushOutcome['written'];
  libraryVersion: number;
  announceVersion: number;
}> {
  const { store, env, book, actor } = args;
  const origin: ContentOrigin = book.managed === false ? 'portal' : 'sync';

  const before = await readManifest(store);
  const created = !(before && findBook(before, book.id));

  const chapterResults: ChapterResult[] = [];
  const written: PushOutcome['written'] = [];
  let libraryVersion = before?.libraryVersion ?? 0;
  let announceVersion = before ? announceVersionOf(before) : 0;

  for (const chapter of book.chapters ?? []) {
    const existed = before ? !!findChapter(findBook(before, book.id), chapter.id) : false;
    const correction = chapter.correction ?? args.correction ?? existed;
    const saved = await saveChapter({
      store,
      env,
      bookId: book.id,
      chapterId: chapter.id,
      markdown: chapter.markdown,
      correction,
      savedBy: actor,
      origin,
    });
    libraryVersion = saved.libraryVersion;
    announceVersion = saved.announceVersion;
    chapterResults.push({
      chapterId: chapter.id,
      ok: true,
      created: !existed,
      contentHash: saved.contentHash,
      wordCount: saved.wordCount,
      audioStale: saved.audioStale,
    });
    written.push({
      bookId: book.id,
      chapterId: chapter.id,
      contentHash: saved.contentHash,
      charLength: chapter.markdown.length,
    });
  }

  // Book-level metadata and the ownership stamp, written once at the end so it
  // survives the manifest rewrites every saveChapter() above performed.
  const after = (await readManifest(store)) ?? {
    schemaVersion: 1,
    libraryVersion: 0,
    generatedAt: new Date().toISOString(),
    books: [] as BookEntry[],
  };
  let entry = findBook(after, book.id);
  if (!entry) {
    entry = { id: book.id, title: book.title ?? book.id, chapters: [] };
    after.books = [...(after.books ?? []), entry];
  }
  if (book.title !== undefined) entry.title = book.title;
  if (book.author !== undefined) entry.author = book.author;
  if (book.description !== undefined) entry.description = book.description;
  if (book.cover !== undefined) entry.cover = book.cover;
  entry.origin = origin;
  if (origin === 'sync') {
    const source: SyncSource = {
      kind: 'api',
      url: book.source?.url ?? '',
      ...(book.source?.system ? { system: book.source.system } : {}),
      syncedAt: new Date().toISOString(),
    };
    entry.syncSource = source;
  } else {
    delete (entry as { syncSource?: unknown }).syncSource;
  }

  let removed: string[] | undefined;
  if (book.replaceChapters) {
    const keep = new Set((book.chapters ?? []).map((c) => c.id));
    const dropped = (entry.chapters ?? []).filter((ch) => !keep.has(ch.id)).map((ch) => ch.id);
    if (dropped.length > 0) {
      entry.chapters = (entry.chapters ?? []).filter((ch) => keep.has(ch.id));
      removed = dropped;
    }
  }

  libraryVersion = (after.libraryVersion ?? 0) + 1;
  after.libraryVersion = libraryVersion;
  (after as { announceVersion?: number }).announceVersion = announceVersion || libraryVersion;
  announceVersion = announceVersionOf(after);
  after.generatedAt = new Date().toISOString();
  await writeManifest(store, after);

  return {
    book: { bookId: book.id, ok: true, created, chapters: chapterResults, ...(removed ? { removed } : {}) },
    written,
    libraryVersion,
    announceVersion,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Bulk import from an archive (plan §8, item 3: "onboarding day")
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Read the blessed markdown-folder layout out of an unzipped archive and return
 * it as ordinary book pushes, so a zip upload and a JSON batch go through
 * exactly the same `pushBooks()` — one validation path, one write path, one
 * report shape.
 *
 * The layout rules are the ones `packages/pipeline/lib/markdown-import.mjs`
 * already documents (docs/authoring-stories.md), restated here over an in-memory
 * entry map instead of a directory because a Worker has no filesystem:
 *
 *   books/<book-id>/book.json      optional — { title, author, description }
 *   books/<book-id>/NN-<slug>.md   one chapter, ordered by filename
 *   books/<book-id>.md             a single-chapter book, chapter id "full"
 *
 * Only the LAYOUT is restated. The markdown itself is never parsed here — it is
 * handed to `saveChapter()` verbatim, which runs the same parser the CLI and the
 * portal do. A leading `books/` prefix is optional: an operator who zips the
 * `books` folder itself gets the same result as one who zips its parent, because
 * both are what people actually do and neither is worth a support ticket.
 */
export function booksFromArchive(entries: Map<string, Uint8Array>): { books: BookPush[]; ignored: { name: string; reason: string }[] } {
  const decoder = new TextDecoder();
  const byBook = new Map<string, { meta?: Record<string, unknown>; files: { name: string; text: string }[]; single?: string }>();
  const ignored: { name: string; reason: string }[] = [];

  const names = [...entries.keys()].map((n) => n.replace(/\\/g, '/').replace(/^\.\//, ''));
  // An archive that HAS a `books/` folder is read strictly from inside it, so a
  // top-level README or LICENSE cannot become a book. An archive with no such
  // folder is read as already-relative, which is what an operator who zipped the
  // CONTENTS of their books folder produces — both are what people actually do,
  // and getting either wrong is a support ticket.
  const rooted = names.some((n) => n === 'books' || n.includes('books/'));

  for (const [rawName, bytes] of entries) {
    const name = rawName.replace(/\\/g, '/').replace(/^\.\//, '');
    if (name.endsWith('/')) continue;
    // Ignore the noise every real archive carries, silently: nobody wants a
    // report line about .DS_Store.
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (base.startsWith('.') || name.startsWith('__MACOSX/')) continue;

    const rel = relativeToBooks(name, rooted);
    if (rel === null) {
      ignored.push({ name, reason: 'not inside a `books/` folder' });
      continue;
    }
    const parts = rel.split('/');

    if (parts.length === 1) {
      if (!parts[0].endsWith('.md')) {
        ignored.push({ name, reason: 'a loose file that is not a `<book-id>.md` single-chapter book' });
        continue;
      }
      slot(byBook, parts[0].slice(0, -3)).single = decoder.decode(bytes);
      continue;
    }
    if (parts.length !== 2) {
      ignored.push({ name, reason: 'nested deeper than `books/<book-id>/<chapter>.md`' });
      continue;
    }
    const [bookId, file] = parts;
    if (file === 'book.json') {
      try {
        const meta = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
        if (meta && typeof meta === 'object' && !Array.isArray(meta)) slot(byBook, bookId).meta = meta;
      } catch {
        // A broken book.json costs the book its metadata, not its chapters:
        // titles come from front matter as a fallback anyway.
        ignored.push({ name, reason: 'not valid JSON — the book keeps its chapters and takes its title from front matter' });
      }
      continue;
    }
    if (!file.endsWith('.md')) {
      ignored.push({ name, reason: 'not a .md chapter' });
      continue;
    }
    slot(byBook, bookId).files.push({ name: file, text: decoder.decode(bytes) });
  }

  const books: BookPush[] = [];
  for (const [bookId, held] of [...byBook.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const chapters: ChapterPush[] = [];
    if (held.single !== undefined) chapters.push({ id: 'full', markdown: held.single });
    for (const file of held.files.sort((a, b) => a.name.localeCompare(b.name))) {
      chapters.push({ id: chapterIdFromFilename(file.name), markdown: file.text });
    }
    if (chapters.length === 0) continue;
    // A folder name that cannot be a book id is reported, not silently renamed:
    // quietly turning "The Keepers" into "the-keepers" would break every link a
    // publisher already has, which is the same reason sync.mjs refuses rather
    // than sanitises.
    if (!ID_RE.test(bookId)) {
      ignored.push({
        name: `books/${bookId}`,
        reason: `"${bookId}" is not a usable book id (1-64 lowercase letters, digits or hyphens). Rename the folder — ids are URL segments and storage keys, so renaming them for you would break links.`,
      });
      continue;
    }
    books.push({
      id: bookId,
      title: optionalString(held.meta?.title),
      author: optionalString(held.meta?.author),
      description: optionalString(held.meta?.description),
      chapters,
    });
  }
  return { books, ignored };
}

function slot(
  map: Map<string, { meta?: Record<string, unknown>; files: { name: string; text: string }[]; single?: string }>,
  bookId: string
) {
  let held = map.get(bookId);
  if (!held) {
    held = { files: [] };
    map.set(bookId, held);
  }
  return held;
}

/** `books/a/b.md` → `a/b.md`, and anything outside a `books/` folder → null. */
function relativeToBooks(name: string, rooted: boolean): string | null {
  if (!rooted) return name;
  if (name.startsWith('books/')) return name.slice(6);
  const at = name.indexOf('/books/'); // a zip whose entries sit under one top folder
  return at >= 0 ? name.slice(at + 7) : null;
}

/** `02-the-long-dark.md` → `the-long-dark`. Same rule markdown-import.mjs uses. */
function chapterIdFromFilename(file: string): string {
  const stem = file.replace(/\.md$/, '');
  return stem.replace(/^\d+[-_.]?/, '') || stem;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Catalogue state, for change detection
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a pushing system needs in order to push only what changed: every book and
 * chapter with its current content hash and who owns it.
 *
 * Deliberately answered from `manifest.json` alone, like the portal's own
 * listing, so a catalogue of a thousand short stories costs one storage read.
 */
export function catalogueOf(manifest: LibraryManifest | null): {
  libraryVersion: number;
  announceVersion: number;
  books: {
    id: string;
    title?: string;
    author?: string;
    origin: string;
    writableByApi: boolean;
    syncSource?: SyncSource;
    chapters: { id: string; contentHash: string; wordCount: number; hasAudio: boolean; audioStale: boolean }[];
  }[];
} {
  if (!manifest) return { libraryVersion: 0, announceVersion: 0, books: [] };
  return {
    libraryVersion: manifest.libraryVersion ?? 0,
    announceVersion: announceVersionOf(manifest),
    books: (manifest.books ?? []).map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      origin: typeof b.origin === 'string' ? b.origin : 'cli',
      /** False exactly when a pull connector owns it — see isPullManaged(). */
      writableByApi: !isPullManaged(b),
      syncSource: syncSourceOf(b),
      chapters: (b.chapters ?? []).map((ch) => ({
        id: ch.id,
        contentHash: ch.contentHash,
        wordCount: ch.wordCount,
        hasAudio: ch.hasAudio === true,
        audioStale: ch.audioStale === true,
      })),
    })),
  };
}
