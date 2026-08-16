// Content types — mirror of the R2 chapter/timings/manifest schemas
// produced by the publish pipeline (tools/).

/**
 * Brand identity + look, and the presentation keys the engine reads today.
 *
 * Deliberately carries NO addresses and NO keys (AB#7413/7414): `appOrigin`,
 * `contentOrigin`, `vapidPublicKey` and `tts` describe one particular
 * deployment, not the brand, and live in DeploymentConfig below. That
 * separation is what lets the same brand run on two platforms.
 */
export interface Brand {
  id: string;
  name: string;
  appName: string;
  shortName?: string;
  tagline: string;
  themeColor: string;
  backgroundColor: string;
  defaultTheme: 'dark' | 'light';
  author: string;
  /**
   * Library shape. 'flat' — standalone units shown in one flat list (no
   * collection level). 'series' — units are grouped into collections.
   */
  layout: 'flat' | 'series';
  /** What a content unit and its collection are called throughout the UI. */
  nouns: ContentNouns;
  fonts?: { display: string; headers: string; body: string; mono: string };
}

/**
 * Where this copy of the app lives and what it talks to (AB#7414).
 *
 * Resolved at RUNTIME, not baked: the platform serving the document injects
 * the values from its own environment, and the build-time values from
 * deployment/<id>/deployment.json are only the fallback for a context with no
 * server-side injection (`vite dev`, `vite preview`, a bare static host). See
 * ../deployment.ts.
 */
export interface DeploymentConfig {
  /** Where the app is served, e.g. https://app.example.com. */
  appOrigin: string;
  /** Where published content is served from; '' means same-origin. */
  contentOrigin: string;
  /** Web-push VAPID public key (base64url). '' disables the push toggle. */
  vapidPublicKey: string;
  /** Narration config — consumed by the publish pipeline, not by the app. */
  tts?: { voice?: string; rate?: string; outputFormat?: string; voices?: string[] };
}

/**
 * Brand content nouns — the single source of truth for what a content unit is
 * called in the UI. A 'flat' library publishes standalone units with no
 * collection (`collection: null`); a 'series' library groups units into
 * collections. Every user-visible string uses these instead of hardcoded nouns.
 */
export interface ContentNouns {
  /** One content unit, e.g. 'story' or 'chapter'. */
  unit: string;
  unitPlural: string;
  Unit: string;
  UnitPlural: string;
  /** The collection a unit belongs to (e.g. 'book'), or null for a flat library. */
  collection: string | null;
  Collection: string | null;
}

export interface LibraryManifest {
  schemaVersion: number;
  libraryVersion: number;
  generatedAt: string;
  books: BookEntry[];
  /** Narrator voices available across the library: voice id → display name.
   *  Absent/single-entry = no in-app voice choice (pre-voices manifests stay valid). */
  voices?: Record<string, string>;
}

/** One narrator voice's audio + word timings for a chapter. */
export interface VoiceTrack {
  audio: string; // R2 path
  timings: string; // R2 path
}

export interface BookEntry {
  id: string;
  title: string;
  author: string;
  cover?: string;
  group?: string; // optional collection/era label for flat libraries
  /** Series grouping (schema v1 additive fields — absent in older manifests). */
  series?: string;
  seriesOrder?: number;
  bookOrder?: number;
  description?: string;
  publishDate?: string; // ISO date the book/story was first published
  timeframe?: string; // flat libraries: in-world time "YYYY-MM" for chronological sort (absent in older manifests)
  chapters: ChapterEntry[];
}

export interface ChapterEntry {
  id: string;
  title: string;
  label?: string;
  setting?: string;
  wordCount: number;
  readingTime?: string;
  audioDurationMs: number;
  contentHash: string;
  content: string; // R2 path
  audio?: string;
  timings?: string;
  /** Per-voice tracks (keys match LibraryManifest.voices). `audio`/`timings`
   *  above remain the library's default voice for older apps. */
  voices?: Record<string, VoiceTrack>;
  hasAudio: boolean;
  publishedAt?: string;
}

export type Block =
  | { id: string; type: 'paragraph'; text: string; spans?: StyleSpan[] }
  | { id: string; type: 'scene-break' }
  | { id: string; type: 'display-beat'; text: string }
  | { id: string; type: 'message-block'; messages: { speaker: string; time: string; text: string }[] }
  | { id: string; type: 'image'; src: string; alt: string }
  | { id: string; type: 'end-marker'; text: string };

export interface StyleSpan {
  start: number;
  end: number;
  style: 'em' | 'strong';
}

export interface ChapterContent {
  id: string;
  bookId: string;
  title: string;
  label?: string;
  blocks: Block[];
  charLength: number;
}

export interface ChapterTimings {
  schemaVersion: number;
  durationMs: number;
  blocks: BlockTiming[];
}

export interface BlockTiming {
  blockId: string;
  startMs: number;
  /** [charStart, charEnd, startMs, endMs] per word, offsets relative to the block text. */
  words: [number, number, number, number][];
}

export interface Progress {
  bookId: string;
  chapterId: string;
  mode: 'read' | 'listen';
  charOffset: number;
  audioMs: number;
  percent: number;
  updatedAt: number;
}

export interface DownloadRecord {
  bookId: string;
  chapterId: string;
  contentHash: string;
  bytes: number;
  hasAudio: boolean;
  completedAt: number;
}

/** How the reader consumes an item: audio only, text only, or text following audio. */
export type ConsumptionMode = 'listen' | 'read' | 'both';

export interface Settings {
  fontScale: number; // 0..4
  lineHeight: number; // 1.5 | 1.7 | 1.9
  theme: 'dark' | 'light' | 'auto';
  readAlong: 'word' | 'block' | 'off';
  /** Default consumption mode when opening an item without a per-item choice. */
  defaultMode: ConsumptionMode;
  /** Check for + fetch new content when the app opens or regains connectivity. */
  autoSync: boolean;
  /** flat: auto-download new units (incl. audio); series: keep the whole collection downloaded. */
  autoDownload: boolean;
  /** Narrator voice id (from LibraryManifest.voices); '' = the library default. */
  narratorVoice: string;
  /** Hold a screen wake lock while read-along plays (visible tab only). */
  keepAwake: boolean;
  /** When a standalone story ends, start the next one automatically. Chapters
   *  within a book always flow regardless; this only governs crossing into the
   *  next book (which flat-library brands present as the next story). */
  autoPlayNextStory: boolean;
}
