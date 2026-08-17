/**
 * The shapes the deployment's content storage holds (AB#7420).
 *
 * These mirror `packages/core/src/lib/types.ts` — deliberately declared again
 * rather than imported, for the same reason `BRAND_GLOBAL` is spelled out in
 * two places: the backend must not depend on the frontend package, nor the
 * frontend on the backend. They are structural types over a JSON wire format
 * that already has to stay compatible in both directions, so a divergence is
 * caught by the manifest itself, not hidden by a shared import.
 *
 * Only the fields the Worker actually reads or writes are typed strictly;
 * everything else on a book/chapter entry is carried through untouched so an
 * edit made by a newer pipeline is never silently dropped by an older Worker.
 */

/**
 * Where a piece of content came from (AB#7422 / AB#7426 — plan §8).
 *
 * The rule the whole large-provider story rests on: **whoever owns the content
 * owns the edit button.** A deployment can hold all of these side by side —
 * that is the point of recording it per book/chapter rather than as one global
 * "mode" — and each behaves correctly on its own terms:
 *
 *   portal   — written here, in the admin portal. Fully editable.
 *   cli      — published by packages/pipeline/publish.mjs from an operator's
 *              own markdown. Editable here too; the next publish reconciles
 *              (that is what `publish.mjs --pull` is for).
 *   sync     — pulled from an EXTERNAL source of truth (a git repo of markdown,
 *              or the publisher's own feed). READ-ONLY in the portal: an edit
 *              made here would be silently overwritten by the next sync, so the
 *              portal refuses it and says where the edit belongs instead.
 *   personal — a reader's own import (PDF/EPUB), device-local and never
 *              uploaded to a deployment. Plan §5, deliberately NOT built: this
 *              value exists so that feature has a seam to arrive through rather
 *              than needing a schema change to start.
 *
 * Absent means `cli`. Every manifest written before this field existed was
 * written by publish.mjs — the portal's own save path (AB#7420) is newer than
 * the pipeline by a wide margin and there was no other writer — so that default
 * is a statement of fact, not a guess. It matters that the default is a
 * WRITABLE origin: an older library must not become read-only because a field
 * it predates is missing.
 */
export type ContentOrigin = 'portal' | 'cli' | 'sync' | 'personal';

/** The origin an entry with no `origin` field is treated as. See ContentOrigin. */
export const DEFAULT_ORIGIN: ContentOrigin = 'cli';

/**
 * Where externally-owned content actually lives, recorded on the book itself so
 * the portal can say "edit it HERE" with a link rather than "edit it somewhere
 * else".
 *
 * On the book rather than in deployment config on purpose: it travels with the
 * content, so a deployment fed by two different repos describes each of them
 * correctly, and the portal needs no extra configuration surface to read.
 *
 * No credential is ever recorded here. A private repo's token belongs to the
 * process running the sync (STORYLARK_SYNC_TOKEN), and the manifest is public.
 *
 * ── On `kind`, and the scope line it must not be confused with ──────────────
 * Plan §8's hard rule is **exactly two PULL CONNECTORS, and no bespoke ones,
 * ever** — `git` and `feed`, the two shapes `packages/pipeline/sync.mjs`
 * implements, guarded by a test that fails if a third is added there. That rule
 * is about code StoryLark writes to go and read somebody's system, which is the
 * unbounded commitment.
 *
 * `api` is the OPPOSITE direction and is the very escape hatch that rule points
 * at: the publisher's own system pushed this content in over the documented
 * content API (docs/content-api.md), so StoryLark wrote no connector at all. It
 * is recorded here for one reason — the portal has to be able to say who owns
 * the edit button, and "an external system pushed it" is a different sentence
 * from "we cloned it from this repo". Adding it does not widen what StoryLark
 * has to maintain by a single line.
 */
export interface SyncSource {
  /**
   * How this content arrived. `git` and `feed` are the two pull connectors;
   * `api` means an external system pushed it in over the content API. There is
   * no fourth, and no third PULL kind — see the note above.
   */
  kind: 'git' | 'feed' | 'api';
  /**
   * Where the original lives, as configured — with any embedded credential
   * stripped. Repo URL (git), feed URL (feed), or the publisher's own canonical
   * URL for this book (api), which may be empty because a pushing system is
   * under no obligation to have a public address.
   */
  url: string;
  /** Git only: the branch or tag synced. */
  ref?: string;
  /** Git only: the subdirectory of the repo that holds `books/`. */
  path?: string;
  /** API only: the pushing system's own name for itself, e.g. "Acme CMS". */
  system?: string;
  /** When this book was last pulled from — or pushed by — that source. */
  syncedAt?: string;
}

export interface StyleSpan {
  start: number;
  end: number;
  style: 'em' | 'strong';
}

export type Block =
  | { id: string; type: 'paragraph'; text: string; spans?: StyleSpan[] }
  | { id: string; type: 'scene-break' }
  | { id: string; type: 'display-beat'; text: string }
  | { id: string; type: 'message-block'; messages: { speaker: string; time: string; text: string }[] }
  | { id: string; type: 'image'; src: string; alt: string }
  | { id: string; type: 'end-marker'; text: string };

export interface ChapterContent {
  id: string;
  bookId: string;
  title?: string;
  label?: string;
  blocks: Block[];
  charLength: number;
}

export interface ChapterEntry {
  id: string;
  title?: string;
  label?: string;
  setting?: string;
  wordCount: number;
  readingTime?: string;
  audioDurationMs: number;
  contentHash: string;
  /** Storage key of the chapter JSON, e.g. books/<book>/chapters/<id>.<hash>.json */
  content: string;
  /**
   * Storage key of the EDITABLE source markdown (AB#7420), e.g.
   * books/<book>/source/<id>.md. Written by publish.mjs and by a portal save.
   * Absent on a chapter published before source upload existed — which is what
   * the portal keys "editable in place" off, without a storage read per chapter.
   */
  source?: string;
  audio?: string;
  timings?: string;
  voices?: Record<string, { audio: string; timings: string }>;
  hasAudio: boolean;
  publishedAt?: string;
  /**
   * Set by a portal text edit (AB#7420): the words moved on and the narration
   * did not. The reader shows it, the portal shows it, and the next pipeline
   * run clears it by re-narrating. Absent means "never edited in the portal",
   * which is the same thing as false — a Worker or app that predates this field
   * simply doesn't mention audio staleness, it doesn't misreport it.
   */
  audioStale?: boolean;
  /**
   * Where this chapter came from (AB#7422). Absent = `cli`, see ContentOrigin.
   * `sync` is the only value that makes a chapter read-only in the portal.
   */
  origin?: ContentOrigin;
  /**
   * What the chapter's own `storylark:` block declared it to be, where it
   * declared anything (content-management wave 2, design §3). `story` and an
   * absent value both leave a one-chapter book presenting as a single;
   * `chapter` is the author stating "this is a book being built", which is what
   * keeps a series book with one chapter so far from rendering as a story.
   */
  declaredType?: 'chapter' | 'story';
  /**
   * The `storylark.order` the chapter declared at ingestion, where it declared
   * one (design §10.6). This is what lets a later arrival's order collide with
   * an incumbent's — the manifest ARRAY stays the presentation order, exactly
   * as before; this field only remembers the declaration.
   */
  order?: number;
  [key: string]: unknown;
}

export interface BookEntry {
  id: string;
  title?: string;
  author?: string;
  cover?: string;
  description?: string;
  chapters: ChapterEntry[];
  /** Where this book came from (AB#7422). Absent = `cli`, see ContentOrigin. */
  origin?: ContentOrigin;
  /** Set when `origin` is `sync`: the external source of truth this book is a
   *  copy of, and therefore where its edit button actually lives. */
  syncSource?: SyncSource;
  /**
   * DERIVED presentation flag (design §3): true when this book presents as a
   * single — cover straight into the text — false when it presents as a book
   * with a chapter list. Recomputed by `refreshSingle()` on every write that
   * changes the chapter set; never authored by a transport (`storylark.type`
   * is the authored truth this is computed from). Absent on a manifest written
   * before this field existed, which the reader treats as "follow the
   * library-wide layout" — exactly the old behaviour.
   */
  single?: boolean;
  [key: string]: unknown;
}

export interface LibraryManifest {
  schemaVersion: number;
  libraryVersion: number;
  generatedAt: string;
  books: BookEntry[];
  voices?: Record<string, string>;
  [key: string]: unknown;
}

/** One entry in a chapter's revision index (`books/<book>/revisions/<chapter>/index.json`). */
export interface RevisionEntry {
  /** Monotonic id, also the storage key stem: revisions/<chapter>/<id>.md */
  id: string;
  savedAt: number;
  /** Who saved it — email or username, whichever the account carries. */
  savedBy: string;
  bytes: number;
  /** True for the revision that is currently live. Pinned: never aged out. */
  live: boolean;
  /** Set when this revision was produced by reverting to an older one. */
  revertedFrom?: string;
  /** Whether the save that produced it was flagged a correction. */
  correction: boolean;
}

export interface RevisionIndex {
  schemaVersion: 1;
  revisions: RevisionEntry[];
}
