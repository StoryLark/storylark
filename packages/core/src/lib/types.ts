// Content types — mirror of the R2 chapter/timings/manifest schemas
// produced by the publish pipeline (tools/).

/**
 * Brand IDENTITY and look. Nothing else.
 *
 * Deliberately carries NO addresses and NO keys (AB#7413/7414): `appOrigin`,
 * `contentOrigin`, `vapidPublicKey` and `tts` describe one particular
 * deployment, not the brand, and live in DeploymentConfig below. That
 * separation is what lets the same brand run on two platforms.
 *
 * And deliberately no `layout`/`nouns` any more (AB#7416 — plan §0d Phase 3):
 * those are PRESENTATION, they live in Presentation below, and they are
 * resolved at runtime from the deployment's own presentation.json. Keeping the
 * two apart in the TYPE is what stops "the brand" quietly re-absorbing the
 * shape of the library the first time somebody adds a field in a hurry.
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

// ── Presentation, the §0b contract (AB#7416 — plan §0d Phase 3) ─────────────
//
// How this library is SHAPED and ARRANGED, as opposed to who it is (Brand) or
// where it lives (DeploymentConfig). Resolved at runtime from the deployment's
// own presentation.json — see ../presentation.ts.
//
// Every field here is REQUIRED in this interface and OPTIONAL in the file: the
// resolver fills anything the file leaves out from DEFAULT_PRESENTATION, so
// components read a complete object and never write `?? somethingElse`. That
// asymmetry is contract rule 1 ("a missing key takes the core default,
// permanently") expressed in the type system — a component physically cannot
// invent a second, competing default for a key.

/** A navigation entry. Also the id used in `nav.items` and `nav.labels`. */
export type NavItem = 'home' | 'library' | 'nowPlaying' | 'settings' | 'about';

/** A Home screen section. Presence in `home.sections` = shown; order = display order. */
export type HomeSection = 'continue' | 'newReleases' | 'allUnits';

/** How the library orders units within a section. */
export type LibrarySort = 'order' | 'title' | 'author' | 'recent' | 'timeframe';

/** How the library divides units into sections. */
export type LibraryGroup = 'none' | 'collection' | 'group' | 'timeframe';

/** How an item opens by default. `readListen` is the app's internal 'both'. */
export type ReaderMode = 'read' | 'listen' | 'readListen';

/**
 * What auto-download means for this library — previously *derived* from
 * `layout`, now stated (plan §0b, "Download behaviour").
 *
 *   newUnits    only units published after the reader turned the toggle on
 *   everything  the whole library, including new units as they publish
 */
export type DownloadMode = 'newUnits' | 'everything';

/** One extra link on the About screen. */
export interface AboutLink {
  label: string;
  href: string;
}

/** A core feature's placement, as stated by a presentation file. */
export interface FeatureConfig {
  enabled: boolean;
  placement?: string;
}

/** The resolved presentation — complete, every key present. */
export interface Presentation {
  /**
   * Library shape. 'flat' — standalone units shown in one flat list (no
   * collection level). 'series' — units are grouped into collections.
   */
  layout: 'flat' | 'series';
  /** What a content unit and its collection are called throughout the UI. */
  nouns: ContentNouns;
  nav: {
    position: 'bottom' | 'side';
    items: NavItem[];
    /** Per-item label override. An item not named here keeps the core label. */
    labels: Partial<Record<NavItem, string>>;
  };
  home: { sections: HomeSection[] };
  library: {
    defaultSort: LibrarySort;
    /** Which sorts the picker offers. Empty = no sort picker. */
    sortOptions: LibrarySort[];
    groupBy: LibraryGroup;
    /** Which groupings the picker offers alongside the sorts. */
    groupOptions: Exclude<LibraryGroup, 'none'>[];
    view: 'grid' | 'list';
    showSearch: boolean;
  };
  reader: { defaultMode: ReaderMode };
  player: { skipSeconds: number; showSpeed: boolean };
  /** Cover shape on the shelves — the most visible difference between brands. */
  cover: { aspect: 'square' | 'portrait' };
  /** Which parts of the unit/collection detail screen appear. */
  detail: {
    showCover: boolean;
    showAuthor: boolean;
    showDescription: boolean;
    showChapterList: boolean;
    /** Reading time / narration duration on each row. */
    showLength: boolean;
  };
  /** Sign-in posture. `true` puts an account gate in front of the whole app. */
  auth: { required: boolean };
  /** Which controls the Settings screen offers the reader. */
  settings: {
    typography: boolean;
    theme: boolean;
    narrator: boolean;
    autoPlay: boolean;
    readAlong: boolean;
    keepAwake: boolean;
    downloads: boolean;
    notifications: boolean;
  };
  download: { mode: DownloadMode };
  /**
   * First-run and empty-shelf copy. `{unit}`, `{unitPlural}`, `{Unit}`,
   * `{UnitPlural}` and `{query}` are substituted; see fillCopy().
   */
  emptyState: { library: string; librarySearch: string; home: string; nowPlaying: string };
  about: { links: AboutLink[] };
  /** Where every NEW core feature lands. Absent feature = the core default. */
  features: Record<string, FeatureConfig>;
}

/**
 * A presentation as a FILE states it: every key optional, at any depth.
 *
 * This is what `presentation/<id>/presentation.json` and the injected
 * `self.__STORYLARK_PRESENTATION__` conform to, and it is deliberately a
 * different type from `Presentation` above — the whole compatibility promise
 * lives in the gap between them.
 */
export type PresentationInput = {
  [K in keyof Presentation]?: Presentation[K] extends Array<unknown> | string
    ? Presentation[K]
    : Partial<Presentation[K]>;
};

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
