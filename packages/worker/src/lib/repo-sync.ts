/**
 * The repo transport — archive-based fetch + strict ingestion inside the
 * deployment (content-management rework wave 2, AB#7420 — design §6, build
 * step 6).
 *
 * ── Thin by construction ────────────────────────────────────────────────────
 * This module is a TRANSPORT under the one-contract architecture (design §2).
 * Its entire job is bytes: fetch the provider's archive over HTTPS (a Worker
 * cannot shell to `git` — §6.3), unpack it, walk the configured path, and hand
 * candidate records to `storylark-contracts/content` — the same gate the
 * portal's save and the public API call. It contains NO validation logic of
 * its own and NO inference: a file is StoryLark content exactly when the
 * contract's own reader finds a `storylark:` block in it, and every rejection
 * below carries the gate's stable code and message, verbatim, so the same
 * malformed file produces the same errors here as through either other door.
 *
 * ── What the transport IS allowed to know ───────────────────────────────────
 * Layout, not meaning. A filename is this transport's address for a
 * `type: story` file that declares no id of its own — the same category of
 * statement as the URL segment the API transport supplies, and the contract
 * validates it like any other id. Everything else — types, ids, order,
 * publish flags — comes from the file's own block or does not exist.
 *
 * ── The decisions this enforces, by number ──────────────────────────────────
 *   §10.1  a chapter in the manifest and absent from the arrival is REPORTED
 *          `missing`, never unpublished. Removal is a human clicking.
 *   §10.5  the first writer owns a bookId; a different source is rejected
 *          `book_owned_elsewhere` naming the owner. This repo re-syncing is an
 *          ordinary update.
 *   §10.6  the stored manifest joins the `order_tie` check.
 *   §10.7  a chapter naming an undeclared, unheld `book:` is rejected
 *          `unknown_book` — evaluated as a SET, so a `type: book` file
 *          anywhere in the same arrival satisfies it. File order never matters.
 */

import type { Env } from '../types';
import type { BookEntry, ChapterContent, ChapterEntry, SyncSource } from '../content-types';
import { getJson, getText, IMMUTABLE, type ContentStore } from './content-store';
import {
  announceVersionOf,
  findBook,
  key,
  originOf,
  readManifest,
  refreshSingle,
  saveChapter,
  syncSourceOf,
  writeManifest,
} from './content';
import { contentHash, parseBlocks, readFrontmatter, stabilizeBlockIds } from './md';
import { sha256Bytes } from './crypto';
import { enqueue } from './narration';
import { recordPublish } from './notify';
import { unzip, ZipError } from 'storylark-contracts/zip';
import {
  bookOwnedElsewhereError,
  isRepoCandidate,
  readStorylarkBlock,
  unknownBookError,
  validateBookCandidate,
  validateChapterCandidate,
  type ContentError,
  type ContentRecord,
} from 'storylark-contracts/content';
import { CONTENT_API_LIMITS } from './content-api';
import { providerOf } from './sync-providers';
import { claimSyncRun, readSyncState, releaseSyncRun, resolveSyncToken, type RepoConnection } from './sync-state';

export type SyncTrigger = 'manual' | 'webhook' | 'schedule' | 'dry-run' | 'connect';

/** One sync's outcome — what the portal's sync report renders, stored verbatim. */
export interface SyncReport {
  ok: boolean;
  dryRun: boolean;
  trigger: SyncTrigger;
  startedAt: string;
  finishedAt: string;
  repo: { provider: string; url: string; branch: string; path: string };
  /** Files with no `storylark:` block — not StoryLark content, by the governing rule. Counted, never errors. */
  ignored: number;
  /** Markdown files that carried a block and were judged. */
  candidates: number;
  books: number;
  chaptersWritten: number;
  chaptersUnchanged: number;
  chaptersWithheld: number;
  imagesIngested: number;
  written: { bookId: string; chapterId: string; contentHash: string }[];
  /** The gate's rejections, verbatim: stable code, same message as any other transport. */
  errors: ContentError[];
  /** Image references that could not be ingested — named, not silently dropped. */
  imageProblems: { file: string; reference: string; reason: string }[];
  /** §10.1 — present in the manifest, absent from this arrival. Reported, NEVER auto-deleted. */
  missing: { bookId: string; chapterId: string; title?: string }[];
  /** Existing non-repo books proven safe to adopt by complete hash parity. */
  adoptionCandidates: string[];
  /** Books whose ownership changed during this real run. Empty for dry-runs. */
  adopted: string[];
  libraryVersion?: number;
  /** A transport-level failure (fetch, unzip, configuration) in one sentence. */
  failure?: string;
}

export type SyncOutcome = { report: SyncReport } | { alreadyRunning: true; runningSince?: number };

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

interface Candidate {
  file: string;
  /** Directory of the file within the content root, for file-relative image resolution. */
  dir: string;
  markdown: string;
  record: ContentRecord;
}

/**
 * Render an incoming candidate exactly far enough to compare it with the live
 * chapter. This is read-only: no source, revision, content object, manifest,
 * narration, or timing is touched. Reusing the live blocks for ID
 * stabilisation makes the result the same hash saveChapter would produce.
 */
async function candidateHash(store: ContentStore, candidate: Candidate, existing: ChapterEntry): Promise<string> {
  const previous = await getJson<ChapterContent>(store, existing.content);
  const { data, body } = readFrontmatter(candidate.markdown);
  const blocks = await stabilizeBlockIds(parseBlocks(body), previous?.blocks);
  const declared = readStorylarkBlock(candidate.markdown);
  const declaredTitle =
    declared.present && typeof declared.fields.title === 'string' && declared.fields.title.trim() !== ''
      ? declared.fields.title
      : undefined;
  const title = declaredTitle ?? (typeof data.title === 'string' ? data.title : (existing.title ?? existing.id));
  return contentHash({ blocks, title });
}

/**
 * The one permitted exception to first-writer ownership: an operator may ask
 * a repo connection to ADOPT a library that is already live, but only when the
 * complete chapter set and every rendered content hash are identical. Visible
 * book metadata, declared ordering, and cover identity must match too. Any
 * uncertainty is a refusal, never a best guess.
 */
async function adoptionMismatch(
  store: ContentStore,
  existing: BookEntry,
  declared: Candidate | undefined,
  group: Candidate[],
  files: Map<string, Uint8Array>
): Promise<string | null> {
  const incoming = group.filter((candidate) => candidate.record.publish !== false);
  const incomingIds = incoming.map((candidate) => candidate.record.chapter ?? 'full').sort();
  const existingIds = (existing.chapters ?? []).map((chapter) => chapter.id).sort();
  if (JSON.stringify(incomingIds) !== JSON.stringify(existingIds)) {
    return `the complete chapter set differs (live: ${existingIds.join(', ') || 'none'}; repo: ${incomingIds.join(', ') || 'none'})`;
  }

  for (const candidate of incoming) {
    const chapterId = candidate.record.chapter ?? 'full';
    const live = (existing.chapters ?? []).find((chapter) => chapter.id === chapterId);
    if (!live) return `chapter "${chapterId}" is not live`;
    const hash = await candidateHash(store, candidate, live);
    if (hash !== live.contentHash) return `chapter "${chapterId}" renders to ${hash}, not the live hash ${live.contentHash}`;
    const incomingOrder = candidate.record.declaredOrder;
    if (incomingOrder !== undefined && incomingOrder !== live.order) {
      return `chapter "${chapterId}" declares order ${incomingOrder}, not the live order ${live.order ?? 'none'}`;
    }
  }

  const projected = JSON.parse(JSON.stringify(existing)) as BookEntry;
  applyBookMetadata(projected, declared, group);
  for (const field of ['title', 'author', 'description'] as const) {
    if (projected[field] !== existing[field]) {
      return `book ${field} differs (live: ${JSON.stringify(existing[field] ?? null)}; repo: ${JSON.stringify(projected[field] ?? null)})`;
    }
  }

  if (declared?.record.cover) {
    const ref = declared.record.cover as string;
    const resolved = resolveRelative(declared.dir, ref) ?? ref;
    const bytes = files.get(resolved) ?? files.get(ref);
    if (!bytes) return `cover "${ref}" is not present in the repository archive`;
    const ext = ref.slice(ref.lastIndexOf('.') + 1).toLowerCase();
    if (!IMAGE_EXT[ext]) return `cover "${ref}" is not an accepted image type`;
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const expected = key.cover(existing.id, (await sha256Bytes(buf)).slice(0, 12), ext);
    if (expected !== existing.cover) return `cover identity differs (live: ${existing.cover ?? 'none'}; repo: ${expected})`;
  }

  return null;
}

function emptyReport(trigger: SyncTrigger, dryRun: boolean, repo: RepoConnection | undefined): SyncReport {
  const now = new Date().toISOString();
  return {
    ok: false,
    dryRun,
    trigger,
    startedAt: now,
    finishedAt: now,
    repo: { provider: repo?.provider ?? '', url: repo?.url ?? '', branch: repo?.branch ?? '', path: repo?.path ?? '' },
    ignored: 0,
    candidates: 0,
    books: 0,
    chaptersWritten: 0,
    chaptersUnchanged: 0,
    chaptersWithheld: 0,
    imagesIngested: 0,
    written: [],
    errors: [],
    imageProblems: [],
    missing: [],
    adoptionCandidates: [],
    adopted: [],
  };
}

/**
 * Run one sync — or one dry-run, which fetches and judges everything and
 * writes NOTHING (the connection form's gate, §6.5: a repo that does not
 * validate cannot be connected).
 *
 * Concurrent real runs are collapsed via the DB claim; dry-runs never claim,
 * because judging is side-effect-free and two of them cannot fight.
 */
export async function runRepoSync(
  env: Env,
  opts: {
    trigger: SyncTrigger;
    dryRun?: boolean;
    actor: string;
    /** Judge THIS connection instead of the stored one — the connection form's dry-run. */
    connection?: RepoConnection;
    /** Explicit token for a form dry-run, before anything is stored. */
    token?: string;
    waitUntil?: (p: Promise<unknown>) => void;
  }
): Promise<SyncOutcome> {
  const dryRun = opts.dryRun === true;
  const state = await readSyncState(env);
  const repo = opts.connection ?? (state?.config?.mode === 'repo' ? state.config.repo : undefined);

  const report = emptyReport(opts.trigger, dryRun, repo);
  if (!repo) {
    report.failure = 'No repo connection is configured. Set the content source to "repo" and connect one first.';
    return { report };
  }
  const provider = providerOf(repo.provider);
  if (!provider) {
    report.failure = `"${repo.provider}" is not a provider this deployment knows. Supported: github.`;
    return { report };
  }
  const parsed = provider.parseRepo(repo.url);
  if (!parsed) {
    report.failure = `"${repo.url}" is not a ${provider.label} repository URL this understands — expected https://github.com/owner/repo.`;
    return { report };
  }

  if (!dryRun) {
    const claim = await claimSyncRun(env);
    if (!claim.claimed) return { alreadyRunning: true, runningSince: claim.runningSince };
  }

  try {
    const store = env.CONTENT_STORE;
    if (!store) {
      report.failure = 'This deployment has no writable content storage bound, so synced content has nowhere to land.';
      return await finish(env, report, dryRun);
    }

    // ── Fetch the archive (§6.3) ──────────────────────────────────────────
    const token = opts.token ?? resolveSyncToken(env, state);
    const url = provider.archiveUrl(parsed, repo.branch, env.CONTENT_SYNC_ARCHIVE_BASE);
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(url, { headers: provider.archiveHeaders(token), redirect: 'follow' });
      if (!res.ok) {
        report.failure =
          `${provider.label} answered ${res.status} for ${repo.url} (branch ${repo.branch}).` +
          (res.status === 404 || res.status === 401 || res.status === 403
            ? token
              ? ' A token was supplied — check it can read this repository and that the branch exists.'
              : ' If the repository is private, configure a read-only token.'
            : '');
        return await finish(env, report, dryRun);
      }
      bytes = await res.arrayBuffer();
    } catch (err) {
      report.failure = `Could not fetch the archive: ${(err as Error).message}`;
      return await finish(env, report, dryRun);
    }
    if (bytes.byteLength > CONTENT_API_LIMITS.maxImportBytes) {
      report.failure = `The repository archive is ${Math.round(bytes.byteLength / 1024 / 1024)}MB; the limit is ${Math.round(
        CONTENT_API_LIMITS.maxImportBytes / 1024 / 1024
      )}MB. Point \`path\` at the content directory, or split the repository.`;
      return await finish(env, report, dryRun);
    }

    let entries: Map<string, Uint8Array>;
    try {
      entries = await unzip(new Uint8Array(bytes), {
        maxEntries: CONTENT_API_LIMITS.maxImportEntries,
        maxEntryBytes: CONTENT_API_LIMITS.maxChapterBytes,
        maxTotalBytes: CONTENT_API_LIMITS.maxImportBytes,
      });
    } catch (err) {
      report.failure = err instanceof ZipError ? err.message : `Could not unpack the archive: ${(err as Error).message}`;
      return await finish(env, report, dryRun);
    }

    // GitHub's zipball wraps everything in one `owner-repo-<sha>/` folder;
    // strip a shared top folder so every name is REPOSITORY-relative — the
    // path an author sees in their own repo is the path every error names.
    const files = stripSharedTop(entries);
    const scope = repo.path.replace(/^\/+|\/+$/g, '');
    const scopePrefix = scope ? `${scope}/` : '';
    const inScope = (name: string) => !scopePrefix || name.startsWith(scopePrefix);
    if (![...files.keys()].some(inScope)) {
      report.failure = scope
        ? `The archive holds nothing under "${scope}". Check the path — it is relative to the repository root.`
        : 'The archive holds no files at all.';
      return await finish(env, report, dryRun);
    }

    // ── Walk: candidates in, everything else ignored (the governing rule) ──
    const decoder = new TextDecoder();
    const candidates: Candidate[] = [];
    for (const [name, data] of files) {
      if (!name.toLowerCase().endsWith('.md') || !inScope(name)) continue;
      const markdown = decoder.decode(data);
      if (!isRepoCandidate(markdown)) {
        // Not StoryLark content. Ignored wherever it sits — opt-in, never inferred.
        report.ignored++;
        continue;
      }
      const block = readStorylarkBlock(markdown, { file: name });
      report.candidates++;
      // A `type: story` file may leave its ids to the transport: the FILENAME
      // is this transport's address for it, the way a URL segment is the
      // API's. Only a story gets that address — a chapter or book file must
      // state its own identity, and handing it one here would hide a missing
      // required field.
      const isStory = block.fields.type === 'story';
      const base = name.slice(name.lastIndexOf('/') + 1).replace(/\.md$/i, '');
      const candidate = {
        file: name,
        markdown,
        ...(isStory ? { bookId: typeof block.fields.book === 'string' ? block.fields.book : base, chapterId: 'full' } : {}),
      };
      const verdict = validateChapterCandidate(candidate, { requireBlock: true });
      if (!verdict.ok) {
        // Judge the whole arrival before writing anything. We still collect
        // every useful error, but a malformed candidate makes the batch
        // ineligible for publication (the atomic validation gate below).
        report.errors.push(...verdict.errors);
        continue;
      }
      candidates.push({ file: name, dir: name.slice(0, name.lastIndexOf('/') + 1), markdown, record: verdict.record });
    }

    // ── Group the arrival as a SET (§10.7) ────────────────────────────────
    const manifest = await readManifest(store);
    const declaredBooks = new Map<string, Candidate>(); // type: book / story declarations
    const duplicateDeclarations = new Set<string>();
    const chapterGroups = new Map<string, Candidate[]>();
    for (const c of candidates) {
      if (c.record.type === 'book') {
        const previous = declaredBooks.get(c.record.book as string);
        if (previous) {
          const bookId = c.record.book as string;
          const message = `book "${bookId}" is declared by more than one file in this arrival. Keep exactly one \`type: book\` or \`type: story\` declaration.`;
          if (!duplicateDeclarations.has(bookId)) report.errors.push({ code: 'duplicate_book', message, file: previous.file } as ContentError);
          report.errors.push({ code: 'duplicate_book', message, file: c.file } as ContentError);
          duplicateDeclarations.add(bookId);
        }
        declaredBooks.set(c.record.book as string, c);
      } else if (c.record.type === 'story') {
        const previous = declaredBooks.get(c.record.book as string);
        if (previous) {
          const bookId = c.record.book as string;
          const message = `book "${bookId}" is declared by more than one file in this arrival. Keep exactly one \`type: book\` or \`type: story\` declaration.`;
          if (!duplicateDeclarations.has(bookId)) report.errors.push({ code: 'duplicate_book', message, file: previous.file } as ContentError);
          report.errors.push({ code: 'duplicate_book', message, file: c.file } as ContentError);
          duplicateDeclarations.add(bookId);
        }
        declaredBooks.set(c.record.book as string, c);
        push(chapterGroups, c.record.book as string, c);
      } else {
        push(chapterGroups, c.record.book as string, c);
      }
    }
    // Two files claiming the same chapter of the same book is ambiguity, and
    // the gate never guesses (§2) — BOTH are rejected, because keeping
    // whichever the archive listed first would make file order matter, which
    // set evaluation (§10.7) forbids.
    for (const [bookId, group] of chapterGroups) {
      const counts = new Map<string, number>();
      for (const c of group) {
        const id = c.record.chapter ?? 'full';
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const dups = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id));
      if (dups.size === 0) continue;
      for (const c of group) {
        const id = c.record.chapter ?? 'full';
        if (dups.has(id)) {
          report.errors.push({
            code: 'duplicate_chapter',
            message: `chapter "${bookId}/${id}" is declared by more than one file in this arrival. A duplicated chapter is never silently resolved — keep exactly one.`,
            file: c.file,
          } as ContentError);
        }
      }
      chapterGroups.set(
        bookId,
        group.filter((c) => !dups.has(c.record.chapter ?? 'full'))
      );
    }

    // A book file declaring a book no chapter mentions is fine (metadata-only
    // update); a chapter naming a book neither held nor declared is not.
    for (const [bookId, group] of [...chapterGroups]) {
      const held = manifest ? !!findBook(manifest, bookId) : false;
      if (!held && !declaredBooks.has(bookId)) {
        for (const c of group) report.errors.push(unknownBookError(bookId, { file: c.file }));
        chapterGroups.delete(bookId);
      }
    }

    // ── Ownership (§10.5): first writer owns the id ───────────────────────
    const sameRepo = (source: SyncSource | undefined): boolean => {
      if (source?.kind !== 'git') return false;
      const theirs = provider.parseRepo(source.url);
      return !!theirs && theirs.owner.toLowerCase() === parsed.owner.toLowerCase() && theirs.repo.toLowerCase() === parsed.repo.toLowerCase();
    };
    const targets = new Set([...chapterGroups.keys(), ...declaredBooks.keys()]);
    const adopting = new Set<string>();
    for (const bookId of [...targets]) {
      const existing = manifest ? findBook(manifest, bookId) : undefined;
      if (!existing) continue;
      if (originOf(existing) === 'sync' && sameRepo(syncSourceOf(existing))) continue; // ordinary update
      const involved = new Map<string, Candidate>();
      for (const c of chapterGroups.get(bookId) ?? []) involved.set(c.file, c);
      const declared = declaredBooks.get(bookId);
      if (declared) involved.set(declared.file, declared);
      const mismatch = repo.adoptMatchingExisting
        ? await adoptionMismatch(store, existing, declared, chapterGroups.get(bookId) ?? [], files)
        : 'matching-only adoption was not requested';
      if (repo.adoptMatchingExisting && mismatch === null) {
        adopting.add(bookId);
        report.adoptionCandidates.push(bookId);
        continue;
      }
      for (const c of involved.values()) {
        const owned = bookOwnedElsewhereError(bookId, existing, { file: c.file });
        report.errors.push({
          ...owned,
          message: repo.adoptMatchingExisting
            ? `${owned.message} Matching-only adoption was requested, but ${mismatch}.`
            : `${owned.message} To migrate this exact live book, explicitly enable matching-only adoption; StoryLark will still refuse unless every chapter and visible metadata matches.`,
        });
      }
      chapterGroups.delete(bookId);
      declaredBooks.delete(bookId);
      targets.delete(bookId);
    }

    // ── Order ties, batch AND stored (§10.6) — the gate's own check ───────
    const accepted = new Map<string, Candidate[]>();
    for (const [bookId, group] of chapterGroups) {
      const existing = manifest ? findBook(manifest, bookId) : undefined;
      const gate = validateBookCandidate(
        {
          bookId,
          chapters: group.map((c) => ({
            file: c.file,
            markdown: c.markdown,
            ...(c.record.type === 'story' ? { chapterId: 'full' } : {}),
          })),
          existingChapters: (existing?.chapters ?? []).map((ch) => ({
            chapter: ch.id,
            order: typeof ch.order === 'number' && Number.isInteger(ch.order) ? ch.order : undefined,
          })),
        },
        { requireBlock: true }
      );
      const kept: Candidate[] = [];
      gate.records.forEach((record, i) => {
        if (record) kept.push(group[i]);
      });
      // Only the errors the group pass ADDS (ties) are new; per-file errors
      // were judged and reported above and cannot recur on kept candidates.
      for (const e of gate.errors) if (e.code === 'order_tie') report.errors.push(e);
      if (kept.length > 0 || declaredBooks.has(bookId)) accepted.set(bookId, kept);
    }
    for (const bookId of declaredBooks.keys()) if (!accepted.has(bookId)) accepted.set(bookId, chapterGroups.get(bookId) ?? []);

    // ── §10.1 — flag what this arrival no longer carries. Never delete. ───
    if (manifest) {
      const arrivalHas = new Set<string>();
      for (const [bookId, group] of chapterGroups) for (const c of group) arrivalHas.add(`${bookId}/${c.record.chapter ?? 'full'}`);
      for (const book of manifest.books ?? []) {
        if (!(originOf(book) === 'sync' && sameRepo(syncSourceOf(book)))) continue;
        for (const ch of book.chapters ?? []) {
          if (!arrivalHas.has(`${book.id}/${ch.id}`)) {
            report.missing.push({ bookId: book.id, chapterId: ch.id, ...(ch.title ? { title: ch.title } : {}) });
          }
        }
      }
    }

    report.books = accepted.size;
    // Validation is all-or-nothing. A report may contain every problem in the
    // arrival, but no valid sibling is allowed to publish beside an invalid
    // one: fixing a typo must never also reveal a partially-applied library.
    if (dryRun || report.errors.length > 0) {
      report.ok = report.failure === undefined && report.errors.length === 0;
      return await finish(env, report, dryRun);
    }

    // ── Write, through the one save path every transport shares ───────────
    const written: SyncReport['written'] = [];
    let manifestChanged = false;
    let libraryVersion = manifest?.libraryVersion ?? 0;
    for (const [bookId, group] of accepted) {
      const before = await readManifest(store);
      const beforeBook = before ? findBook(before, bookId) : undefined;
      // Declared order decides the save sequence — the manifest array IS the
      // order, and ties were already rejected, so this sort is total.
      const ordered = [...group].sort((a, b) => (a.record.declaredOrder ?? 0) - (b.record.declaredOrder ?? 0));
      for (const c of ordered) {
        const chapterId = c.record.chapter ?? 'full';
        if (c.record.publish === false) {
          report.chaptersWithheld++;
          continue;
        }
        const markdown = await ingestImages(store, env, c, bookId, files, repo.path, report);
        const existingChapter = beforeBook ? (beforeBook.chapters ?? []).find((ch) => ch.id === chapterId) : undefined;
        if (existingChapter) {
          const exactSource = (await getText(store, key.source(bookId, chapterId))) === markdown;
          const sameRenderedContent = exactSource ? true : (await candidateHash(store, c, existingChapter)) === existingChapter.contentHash;
          if (sameRenderedContent) {
            report.chaptersUnchanged++;
            continue;
          }
        }
        const existed = !!existingChapter;
        try {
          const saved = await saveChapter({
            store,
            env,
            bookId,
            chapterId,
            markdown,
            correction: existed,
            savedBy: opts.actor,
            origin: 'sync',
          });
          libraryVersion = saved.libraryVersion;
          report.chaptersWritten++;
          written.push({ bookId, chapterId, contentHash: saved.contentHash });
        } catch (err) {
          report.errors.push({ code: 'write_failed', message: `${bookId}/${chapterId}: ${(err as Error).message}`, file: c.file } as ContentError);
        }
      }

      // Book-level metadata + the ownership stamp, once per book. Written only
      // when something actually moved: a daily sync of an unchanged repo must
      // not bump `libraryVersion` and make every reader re-fetch a manifest
      // that says nothing new.
      const after = await readManifest(store);
      const entry = after ? findBook(after, bookId) : undefined;
      if (after && entry) {
        const priorSyncedAt = entry.syncSource?.syncedAt;
        const snapshot = JSON.stringify({ ...entry, syncSource: { ...(entry.syncSource ?? {}), syncedAt: '' } });
        applyBookMetadata(entry, declaredBooks.get(bookId), group);
        const declared = declaredBooks.get(bookId);
        if (declared?.record.cover) {
          const coverKey = await ingestCover(store, declared, bookId, files, repo.path, report);
          if (coverKey) entry.cover = coverKey;
        }
        if (adopting.has(bookId)) {
          for (const candidate of group) {
            if (candidate.record.publish === false) continue;
            const chapterId = candidate.record.chapter ?? 'full';
            const chapter = (entry.chapters ?? []).find((item) => item.id === chapterId);
            if (!chapter) continue; // adoptionMismatch proved it exists; fail closed if storage changed mid-run
            chapter.origin = 'sync';
            if (candidate.record.type === 'chapter' || candidate.record.type === 'story') {
              chapter.declaredType = candidate.record.type;
            }
            if (candidate.record.declaredOrder !== undefined) chapter.order = candidate.record.declaredOrder;
          }
          report.adopted.push(bookId);
        }
        entry.origin = 'sync';
        entry.syncSource = {
          kind: 'git',
          url: repo.url,
          ref: repo.branch,
          ...(repo.path ? { path: repo.path } : {}),
          syncedAt: new Date().toISOString(),
        };
        // The manifest array is the presentation order: when every chapter
        // declared one, the array follows the declarations.
        if ((entry.chapters ?? []).length > 1 && entry.chapters.every((ch) => typeof ch.order === 'number')) {
          entry.chapters = [...entry.chapters].sort((a, b) => (a.order as number) - (b.order as number));
        }
        refreshSingle(entry);
        const changed =
          written.some((w) => w.bookId === bookId) ||
          snapshot !== JSON.stringify({ ...entry, syncSource: { ...(entry.syncSource ?? {}), syncedAt: '' } });
        if (changed) {
          manifestChanged = true;
          libraryVersion = (after.libraryVersion ?? 0) + 1;
          after.libraryVersion = libraryVersion;
          (after as { announceVersion?: number }).announceVersion = announceVersionOf(after);
          after.generatedAt = new Date().toISOString();
          await writeManifest(store, after);
        } else if (priorSyncedAt !== undefined) {
          entry.syncSource.syncedAt = priorSyncedAt; // nothing moved — say so honestly
        }
      }
    }

    report.written = written;
    report.chaptersWritten = written.length;
    report.libraryVersion = libraryVersion;
    report.ok = report.failure === undefined && report.errors.length === 0;

    const waitUntil = opts.waitUntil ?? ((p: Promise<unknown>) => void p.catch(() => {}));
    if (manifestChanged) {
      const final = await readManifest(store);
      const announce = final ? announceVersionOf(final) === final.libraryVersion : false;
      await recordPublish(env, waitUntil, libraryVersion, announce).catch(() => undefined);
    }
    if (written.length > 0) {
      // Any content arriving by any route enqueues narration (design §8).
      // Non-fatal, exactly as the portal's save treats it.
      try {
        await enqueue(
          env,
          written.map((w) => ({ bookId: w.bookId, chapterId: w.chapterId, contentHash: w.contentHash })),
          { requestedBy: opts.actor, label: `repo sync: ${repo.url}` }
        );
      } catch {
        /* pre-0008 database — audioStale still tells the truth */
      }
    }

    return await finish(env, report, dryRun);
  } finally {
    if (!dryRun) await releaseSyncRun(env, null).catch(() => undefined);
  }
}

/** Record the report (real runs only) and hand it back. */
async function finish(env: Env, report: SyncReport, dryRun: boolean): Promise<SyncOutcome> {
  report.finishedAt = new Date().toISOString();
  if (report.failure === undefined && report.errors.length === 0) report.ok = true;
  if (!dryRun) await releaseSyncRun(env, report).catch(() => undefined);
  return { report };
}

/**
 * The scheduled pull (§10.3): a second job on the cron every deployment
 * already has. The cron fires daily; a connection with a LONGER configured
 * interval simply skips runs until it is due. Silent when repo mode is not
 * configured — a cron tick is not an error.
 */
export async function scheduledContentSync(env: Env): Promise<void> {
  const state = await readSyncState(env);
  if (state?.config?.mode !== 'repo' || !state.config.repo) return;
  const intervalMs = Math.max(1, state.config.repo.intervalHours || 24) * 3600 * 1000;
  // A five-minute grace keeps a daily interval from slipping a full day when
  // the cron fires seconds earlier than yesterday.
  if (state.lastSyncAt && Date.now() - state.lastSyncAt < intervalMs - 5 * 60 * 1000) return;
  await runRepoSync(env, { trigger: 'schedule', actor: 'schedule' }).catch((err) =>
    console.error(`storylark: scheduled content sync failed: ${(err as Error).message}`)
  );
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

function push(map: Map<string, Candidate[]>, bookId: string, c: Candidate): void {
  const list = map.get(bookId);
  if (list) list.push(c);
  else map.set(bookId, [c]);
}

/**
 * Normalise archive entry names to repository-relative: strip the single
 * shared top-level folder a provider zipball wraps everything in. Pure path
 * mechanics — nothing here reads content. The configured `path` is applied by
 * the caller as a FILTER on markdown candidacy, not by rewriting names: error
 * locations stay the paths the author sees in their own repository, and image
 * references still resolve file-relative then repo-root-relative (§6.5).
 */
function stripSharedTop(entries: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const names = [...entries.keys()].filter((n) => !n.endsWith('/'));
  if (names.length === 0) return new Map();
  const firstSeg = (n: string) => (n.includes('/') ? n.slice(0, n.indexOf('/')) : null);
  const top = firstSeg(names[0]);
  const shared = top !== null && names.every((n) => firstSeg(n) === top);
  const prefix = shared ? `${top}/` : '';

  const out = new Map<string, Uint8Array>();
  for (const [name, data] of entries) {
    if (name.endsWith('/')) continue;
    out.set(prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name, data);
  }
  return out;
}

/** Resolve a relative reference against a file's directory, staying inside the root. */
function resolveRelative(dir: string, ref: string): string | null {
  const parts = (dir + ref).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null; // escapes the content root
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

const INLINE_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Ingest a chapter's relative image references (design §6.5 — Images):
 * resolved file-relative then root-relative, stored with the same
 * content-hashed keys and the same type allowlist portal uploads get — a repo
 * cannot inject an asset type a portal upload would refuse; SVG stays refused.
 * The reference in the saved markdown becomes the ingested URL, because
 * hotlinking the repo would break offline downloads.
 */
async function ingestImages(
  store: ContentStore,
  env: Env,
  c: Candidate,
  bookId: string,
  files: Map<string, Uint8Array>,
  _path: string,
  report: SyncReport
): Promise<string> {
  const originPrefix = (env.CONTENT_ORIGIN ?? '').replace(/\/+$/, '');
  const replacements = new Map<string, string>();
  for (const match of c.markdown.matchAll(INLINE_IMAGE_RE)) {
    const ref = match[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('/')) continue; // absolute — not ours to fetch
    if (replacements.has(ref)) continue;
    const resolved = resolveRelative(c.dir, ref) ?? ref;
    const bytes = files.get(resolved) ?? files.get(ref); // file-relative, then root-relative
    if (!bytes) {
      report.imageProblems.push({ file: c.file, reference: ref, reason: 'no such file in the repository — the reference is left as written' });
      continue;
    }
    const ext = ref.slice(ref.lastIndexOf('.') + 1).toLowerCase();
    const type = IMAGE_EXT[ext];
    if (!type) {
      report.imageProblems.push({
        file: c.file,
        reference: ref,
        reason: `".${ext}" isn't an image type this accepts (PNG, JPEG, WebP, GIF or AVIF — the same rule portal uploads follow; SVG is refused).`,
      });
      continue;
    }
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const hash = (await sha256Bytes(buf)).slice(0, 12);
    const base = resolved.slice(resolved.lastIndexOf('/') + 1);
    const slugged = slugify(base, ext);
    const storageKey = key.image(bookId, `${slugged}-${hash}.${ext}`);
    await store.put(storageKey, buf, { contentType: type, cacheControl: IMMUTABLE });
    replacements.set(ref, `${originPrefix}/${storageKey}`);
    report.imagesIngested++;
  }
  if (replacements.size === 0) return c.markdown;
  return c.markdown.replace(INLINE_IMAGE_RE, (whole, alt: string, ref: string) => {
    const url = replacements.get(ref);
    return url ? `![${alt}](${url})` : whole;
  });
}

/** `storylark.cover` on a `type: book`/`story` file — same keys publish.mjs and the portal use. */
async function ingestCover(
  store: ContentStore,
  declared: Candidate,
  bookId: string,
  files: Map<string, Uint8Array>,
  _path: string,
  report: SyncReport
): Promise<string | null> {
  const ref = declared.record.cover as string;
  const resolved = resolveRelative(declared.dir, ref) ?? ref;
  const bytes = files.get(resolved) ?? files.get(ref);
  if (!bytes) {
    report.imageProblems.push({ file: declared.file, reference: ref, reason: 'cover file not found in the repository' });
    return null;
  }
  const ext = ref.slice(ref.lastIndexOf('.') + 1).toLowerCase();
  const type = IMAGE_EXT[ext];
  if (!type) {
    report.imageProblems.push({ file: declared.file, reference: ref, reason: `".${ext}" isn't an image type this accepts.` });
    return null;
  }
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hash = (await sha256Bytes(buf)).slice(0, 12);
  const storageKey = key.cover(bookId, hash, ext);
  await store.put(storageKey, buf, { contentType: type, cacheControl: IMMUTABLE });
  report.imagesIngested++;
  return storageKey;
}

/**
 * Book metadata from the declaration file's own frontmatter. The `storylark:`
 * block's `title` wins (the contract's rule); `author`/`description` are read
 * from the flat frontmatter — the same fields book.json carries in the blessed
 * layout. A book with no declaration keeps whatever it has: sync never
 * manufactures a title.
 */
function applyBookMetadata(entry: BookEntry, declared: Candidate | undefined, group: Candidate[]): void {
  if (declared) {
    const { data } = readFrontmatter(declared.markdown);
    const title = declared.record.title ?? (typeof data.title === 'string' ? data.title : undefined);
    if (title) entry.title = title;
    if (typeof data.author === 'string') entry.author = data.author;
    if (typeof data.description === 'string') entry.description = data.description;
    return;
  }
  // A story book (declaration IS the chapter) already had its title applied by
  // saveChapter onto the chapter entry; lift it to the book so the shelf shows it.
  if (group.length === 1 && group[0].record.type === 'story') {
    const only = (entry.chapters ?? [])[0];
    if (only?.title) entry.title = only.title;
    const { data } = readFrontmatter(group[0].markdown);
    if (typeof data.author === 'string') entry.author = data.author;
  }
}

/** Same rule the portal's upload uses — a recognisable name, safe as a key. */
function slugify(name: string, ext: string): string {
  const stem = name.replace(/\.[^.]*$/, '').toLowerCase();
  const slug = stem
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `image-${ext}`;
}
