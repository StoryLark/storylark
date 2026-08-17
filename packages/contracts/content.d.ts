// Types for content.mjs — the StoryLark content contract (SCF) validator.
// One implementation, three transports (portal, repo, API); see content.mjs.

/** Highest `storylark.contractVersion` this engine reads. */
export const CONTENT_CONTRACT_VERSION: number;

/** Ids are storage keys and URL segments: 1-64 of [a-z0-9-], starting [a-z0-9]. */
export const CONTENT_ID_RE: RegExp;

/** Per-chapter source ceiling, shared with the content API's limits. */
export const MAX_CHAPTER_SOURCE_BYTES: number;

/** The one error vocabulary. Stable codes; transports render, never rename. */
export const CONTENT_ERROR_CODES: readonly string[];

/** The shared sentence every transport uses when `storylark.publish: false` withholds a chapter. */
export const PUBLISH_WITHHELD_MESSAGE: string;

/** One rejection: a stable code, a human message, and a location where the transport could supply one. */
export interface ContentError {
  code: string;
  message: string;
  /** Where the content came from, when the transport knows (repo path, URL, form). */
  file?: string;
  /** 1-based line in the source file, where one can be named. */
  line?: number;
  /** The `storylark:` field at fault, when one is. */
  field?: string;
}

/** A markdown source split at the frontmatter fence — byte-identical boundary to readFrontmatter's. */
export function splitFrontmatter(source: string): {
  frontmatter: string | null;
  body: string;
  bodyLine: number;
};

/** The parsed `storylark:` block: flat fields, their line numbers, and any structural errors. */
export interface StorylarkBlock {
  present: boolean;
  fields: Record<string, string | number | boolean>;
  fieldLines: Record<string, number>;
  /** 1-based line the `storylark:` key sits on; 0 when absent. */
  line: number;
  errors: ContentError[];
}

export function readStorylarkBlock(source: string, where?: { file?: string }): StorylarkBlock;

/** The repo candidacy question: block present, or a broken fence that mentions one. */
export function isRepoCandidate(source: string): boolean;

/** What a transport hands the gate: identity as the transport knows it, plus the source. */
export interface ChapterCandidate {
  /** Where it came from, for error locations. */
  file?: string;
  /** Book identity the transport supplied (URL segment, form field, folder name). */
  bookId?: string;
  /** Chapter identity the transport supplied. */
  chapterId?: string;
  /** Position the transport supplied (array index, chapter list). A block's own `order` wins. */
  order?: number;
  /** The source, frontmatter included. */
  markdown: string;
}

export interface ValidateOptions {
  /** The strict repo rule: a file without a `storylark:` block is not StoryLark content. */
  requireBlock?: boolean;
}

/** The normalised record the gate produces on success. */
export interface ContentRecord {
  type: 'book' | 'chapter' | 'story';
  book?: string;
  chapter?: string;
  /** Resolved position: the block's own `order` where declared, else the transport's. */
  order?: number;
  /** Set only when the block itself declared `order:` — what the tie rule and any reordering key off. */
  declaredOrder?: number;
  /** Default true; false withholds the chapter from publication. */
  publish: boolean;
  /** `storylark.title` — overrides top-level `title`, then `# H1`. */
  title?: string;
  /** Path relative to the file. Never a URL. */
  cover?: string;
  contractVersion: number;
  /** True when a `storylark:` block declared this record; false for grandfathered, transport-identified content. */
  declared: boolean;
}

export type ChapterValidation =
  | { ok: true; record: ContentRecord; errors: [] }
  | { ok: false; errors: ContentError[] };

export function validateChapterCandidate(candidate: ChapterCandidate, opts?: ValidateOptions): ChapterValidation;

/** An already-published chapter, as the stored manifest knows it — joins the tie check (§10.6). */
export interface ExistingChapter {
  chapter?: string;
  /** The order the chapter DECLARED when it was ingested, where it declared one. */
  order?: number;
}

export interface BookCandidate {
  bookId?: string;
  file?: string;
  chapters?: Omit<ChapterCandidate, 'bookId'>[];
  /** The book's current chapters; a declared order colliding with an incumbent's is the same `order_tie`. */
  existingChapters?: ExistingChapter[];
}

/** Per-chapter validation plus the between-chapters rule: an `order` tie is an error. */
export function validateBookCandidate(
  bookCandidate: BookCandidate,
  opts?: ValidateOptions
): { ok: boolean; records: (ContentRecord | null)[]; errors: ContentError[] };

/** Who currently owns a book, as the manifest records it. */
export interface ContentOwner {
  origin?: unknown;
  syncSource?: { kind?: string; url?: string; ref?: string; system?: string } | undefined;
}

/** §10.7 — a chapter naming a book neither held nor declared by this arrival. */
export function unknownBookError(bookId: string, where?: { file?: string; line?: number }): ContentError;

/** §10.5 — a later arrival from a different source claiming an owned book id. */
export function bookOwnedElsewhereError(bookId: string, owner: ContentOwner, where?: { file?: string; line?: number }): ContentError;

/** The owner of a book, in words a rejection can carry. */
export function describeContentOwner(owner: ContentOwner): string;
