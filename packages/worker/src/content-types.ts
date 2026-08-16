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
  [key: string]: unknown;
}

export interface BookEntry {
  id: string;
  title?: string;
  author?: string;
  cover?: string;
  description?: string;
  chapters: ChapterEntry[];
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
