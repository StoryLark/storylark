// Content types — mirror of the R2 chapter/timings/manifest schemas
// documented in docs/content-pipeline.md.

export interface Brand {
  id: string;
  name: string;
  appName: string;
  tagline: string;
  appOrigin: string;
  contentOrigin: string;
  themeColor: string;
  backgroundColor: string;
  defaultTheme: 'dark' | 'light';
  author: string;
  vapidPublicKey: string;
}

export interface LibraryManifest {
  schemaVersion: number;
  libraryVersion: number;
  generatedAt: string;
  books: BookEntry[];
}

export interface BookEntry {
  id: string;
  title: string;
  author: string;
  cover?: string;
  group?: string; // e.g. Gunner era label
  /** Series grouping (schema v1 additive fields — absent in older manifests). */
  series?: string;
  seriesOrder?: number;
  bookOrder?: number;
  description?: string;
  publishDate?: string; // ISO date the book/story was first published
  timeframe?: string; // gunner: in-world time "YYYY-MM" for chronological sort (absent in older manifests)
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
  /** gunner: auto-download new stories (incl. audio); holdfast: keep the whole book downloaded. */
  autoDownload: boolean;
}
