/// <reference path="./virtual.d.ts" />
// Presentation, resolved at runtime (AB#7416 — plan §0d Phase 3).
//
// ── What this closes ────────────────────────────────────────────────────────
// Phase 2 made WHO a library is (names, colours, fonts) swappable on a live
// deployment. This makes HOW IT IS ARRANGED swappable the same way: which tabs
// exist and in what order, which sections the Home screen shows, how the
// Library sorts and groups, how items open, what the player's skip button
// does, what shape the covers are, what the empty shelf says. All of it used to
// be either hardcoded in a component or compiled into the bundle from
// presentation/<id>/presentation.json.
//
// Three layers, in this order — the same shape Phases 1 and 2 built:
//
//   1. What the platform serving this document injected, from the deployment's
//      OWN dist/presentation.json, at response time —
//      `self.__STORYLARK_PRESENTATION__`, written into the `<head>` of
//      index.html/admin.html and prepended to sw.js by
//      packages/worker/src/lib/presentation.ts (Cloudflare Worker) and
//      platforms/azure/server.mjs (Node).
//   2. What the build baked in — `virtual:storylark-presentation`, the same
//      file as it stood at build time. The fallback for a context nothing
//      injects into: `vite dev`, `vite preview`, a plain static host, or a
//      document served by a platform mid-update still running an older engine.
//   3. DEFAULT_PRESENTATION below — core's complete answer for every key.
//
// ── The two rules that make this survive core updates (plan §0b) ────────────
//
//  1. A MISSING KEY TAKES THE CORE DEFAULT — PERMANENTLY. This is the single
//     most load-bearing property in the whole contract, and it is why
//     DEFAULT_PRESENTATION is exhaustive rather than partial: every key any
//     component reads has a value here, so a presentation.json written today
//     (or the two-key one Phase 0 generated, which states only `layout` and
//     `nouns`) keeps working on every future engine without being edited.
//     Components read `PRESENTATION.x.y` directly and never `?? fallback` —
//     a component-level fallback would be a SECOND default that can disagree
//     with this one, and the first time they disagreed the promise would be
//     quietly untrue.
//
//  2. AN UNKNOWN KEY IS IGNORED WITH A WARNING. Enforced twice on purpose: at
//     the serve boundary (readPresentationAsset in the worker package, against
//     a hand-edited live file) and again here in resolve() (against an injected
//     object from an unknown source, and against the build-time fallback).
//     A file written for a NEWER engine loads on an older one without exploding.
//
// ── Why the defaults are what they are ──────────────────────────────────────
// Every default below is the behaviour the app ALREADY had before this phase,
// established by reading the component, not by taste. That is not politeness:
// if a default differed from current behaviour, then shipping this phase would
// visibly change every existing deployment the moment they updated core — which
// is precisely the failure ("a core update never touches your brand") the whole
// plan exists to prevent. Where current behaviour was derived from `layout`
// rather than stated — the library's grouping, its search box, and what
// auto-download means — layoutDefaults() reproduces the derivation exactly, and
// a presentation file can now override it. Plan §0b lists that coupling as
// "surprising and undocumented"; this is where it stops being implicit.

import fallback from 'virtual:storylark-presentation';
import type {
  ContentNouns,
  FeatureConfig,
  LibraryGroup,
  NavItem,
  Presentation,
  PresentationInput,
} from './lib/types';

/**
 * The global the serving platform writes.
 *
 * Keep in sync with PRESENTATION_GLOBAL in
 * packages/worker/src/lib/presentation.ts. Core deliberately does not import
 * the worker package — the frontend must not depend on the backend — so the
 * name is spelled out in both places, exactly as Phases 1 and 2 do.
 */
export const PRESENTATION_GLOBAL = '__STORYLARK_PRESENTATION__';

/** `id` of the injected `<script>`. Same sync note as above. */
export const PRESENTATION_SCRIPT_ID = 'storylark-presentation';

/**
 * Core's complete answer for every key in the §0b contract.
 *
 * Read this as the specification of the product's out-of-the-box shape. Adding
 * a key here (with a default that matches whatever the code did before it was
 * configurable) is the entire cost of making a new piece of behaviour
 * presentation-controlled; no customer file has to change.
 */
export const DEFAULT_PRESENTATION: Presentation = {
  // Structure — the two keys Phase 0 already split out of brand.json.
  layout: 'flat',
  nouns: {
    unit: 'story',
    unitPlural: 'stories',
    Unit: 'Story',
    UnitPlural: 'Stories',
    collection: null,
    Collection: null,
  },

  // Navigation. Four tabs along the bottom, in this order — components/TabBar.tsx
  // before this phase. `about` exists as an item but is not shown by default,
  // because today About is reached from the Settings footer, not from the bar.
  nav: {
    position: 'bottom',
    items: ['home', 'library', 'nowPlaying', 'settings'],
    labels: {},
  },

  // Home. Continue/Up-next card, then the "New <units>" carousel — screens/Home.tsx
  // before this phase. `allUnits` is available and off by default for the same
  // reason: Home has never had a full listing on it, and turning one on for
  // every existing deployment is not this phase's business.
  home: { sections: ['continue', 'newReleases'] },

  // Library. These are the flat-layout values; layoutDefaults() below carries
  // the series ones. The picker offered exactly these three sorts plus one
  // grouping, in this order, and defaulted to reading order.
  //
  // `groupOptions: ['group']` and not `['collection']` on purpose: the flat
  // shelf's old "By collection" entry bucketed on each unit's own `group` label
  // and ordered the sections by earliest in-world date, which is `group`. The
  // `collection` grouping is the SERIES shelf's rule — bucket on `series`,
  // order by `seriesOrder`. They looked like one feature and were two.
  library: {
    defaultSort: 'order',
    sortOptions: ['order', 'timeframe', 'recent'],
    groupBy: 'none',
    groupOptions: ['group'],
    view: 'list',
    showSearch: true,
  },

  // Reader. 'read' is the initial value of settings.defaultMode in lib/state.ts
  // — this is the DEPLOYMENT's default for a per-reader preference, so a reader
  // who has already chosen keeps their choice (see applyPresentationDefaults).
  reader: { defaultMode: 'read' },

  // Player. 15, not §0b's illustrative 30: ±15s is what the Now Playing and
  // read-along transport buttons have always done. The speed control has always
  // been visible.
  player: { skipSeconds: 15, showSpeed: true },

  // Covers. 3:4 on every shelf surface — .new-card-coverwrap, .continue-cover,
  // .series-book-cover and .book-hero-cover in styles/ui2.css.
  cover: { aspect: 'portrait' },

  // The detail screen showed all five of these.
  detail: {
    showCover: true,
    showAuthor: true,
    showDescription: true,
    showChapterList: true,
    showLength: true,
  },

  // Anonymous browse-and-read. Signing in syncs progress; it has never gated
  // the library.
  auth: { required: false },

  // Every settings control the screen has ever offered.
  settings: {
    typography: true,
    theme: true,
    narrator: true,
    autoPlay: true,
    readAlong: true,
    keepAwake: true,
    downloads: true,
    notifications: true,
  },

  // Flat value; layoutDefaults() carries the series one.
  download: { mode: 'newUnits' },

  // The exact strings the screens carried, with the hardcoded nouns turned into
  // placeholders — for the `storylark` brand these substitute back to the same
  // words, character for character.
  emptyState: {
    library: 'No {unitPlural} published yet. Check back soon.',
    librarySearch: 'No {unitPlural} match “{query}”.',
    home: 'Loading the library…',
    nowPlaying: 'Nothing playing yet.',
  },

  about: { links: [] },

  // Open on purpose: a feature core has not shipped yet is not an unknown key,
  // and a feature a template predates takes the core default. See feature().
  features: {},
};

/**
 * The keys whose pre-phase behaviour was DERIVED from `layout` rather than
 * stated, reproduced exactly.
 *
 * Before this phase the Library grouped by series and offered no search or sort
 * picker in a `series` library, and auto-download meant "keep the whole
 * collection" there and "units published from now on" in a `flat` one — all of
 * it read straight off `BRAND.layout` at the point of use. Those are now
 * ordinary presentation keys with a layout-sensitive DEFAULT, which is what
 * makes them overridable without changing what any existing library does.
 */
function layoutDefaults(layout: Presentation['layout']): PresentationInput {
  if (layout !== 'series') return {};
  return {
    library: { groupBy: 'collection', groupOptions: [], showSearch: false, sortOptions: [] },
    download: { mode: 'everything' },
  };
}

/** The object groups that merge key-by-key. `layout` is a scalar; `nouns` and `features` are handled separately. */
const GROUPS = [
  'nav',
  'home',
  'library',
  'reader',
  'player',
  'cover',
  'detail',
  'auth',
  'settings',
  'download',
  'emptyState',
  'about',
] as const;

/** Known top-level keys. Rule 2's whitelist — anything else is warned about and dropped. */
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  'contractVersion',
  'layout',
  'nouns',
  'features',
  ...GROUPS,
]);

function injected(): PresentationInput | undefined {
  const value = (globalThis as unknown as Record<string, unknown>)[PRESENTATION_GLOBAL];
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as PresentationInput) : undefined;
}

/** True when this document/worker was served by a platform that injects. */
export const PRESENTATION_INJECTED: boolean = injected() !== undefined;

/**
 * Merge a stated presentation over the defaults.
 *
 * All-or-nothing between layers 1 and 2, unlike brand.ts's per-key merge, and
 * deliberately: an injected presentation IS this deployment's presentation, so
 * a key it does not state must fall through to CORE's default, not to the copy
 * of the same file that happened to be on disk at build time. Otherwise
 * deleting `nav` from a live presentation.json would silently reinstate the
 * build's `nav` rather than core's — a third answer, and rule 1 broken by the
 * mechanism that exists to honour it. Brand can merge per key because its two
 * layers have genuinely different sources (a file, and the bundle); both of
 * these layers are the same file at two different times.
 *
 * Objects merge key by key so a file that states `{ library: { view: 'grid' } }`
 * keeps the default sort — all-or-nothing merging would make stating one key
 * silently reset its neighbours, which is the most common way a config system
 * betrays the "missing key takes the default" promise while appearing to honour
 * it. Arrays REPLACE, because `nav.items` and `home.sections` are ordered
 * choices: merging `['home']` into `['home','library','nowPlaying','settings']`
 * would make removing a tab impossible.
 */
export function resolvePresentation(
  stated: PresentationInput | undefined = injected() ?? fallback,
  onWarn: (message: string) => void = (m) => console.warn(m)
): Presentation {
  const doc = (stated ?? {}) as Record<string, unknown>;

  // `layout` first: it selects which defaults the rest resolve against.
  const layout: Presentation['layout'] = doc.layout === 'series' || doc.layout === 'flat' ? doc.layout : DEFAULT_PRESENTATION.layout;
  const byLayout = layoutDefaults(layout) as Record<string, Record<string, unknown> | undefined>;

  const out = { layout } as Presentation;
  out.nouns = { ...DEFAULT_PRESENTATION.nouns, ...pruned(doc.nouns) } as ContentNouns;

  for (const group of GROUPS) {
    (out as unknown as Record<string, unknown>)[group] = {
      ...DEFAULT_PRESENTATION[group],
      ...byLayout[group],
      ...pruned(doc[group]),
    };
  }

  // features: merged one feature at a time, so a file that positions ONE
  // feature does not blank out the defaults core ships for the others.
  const features: Record<string, FeatureConfig> = { ...DEFAULT_PRESENTATION.features };
  for (const [name, cfg] of Object.entries(pruned(doc.features))) {
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    features[name] = { ...features[name], ...(cfg as FeatureConfig) };
  }
  out.features = features;

  // Rule 2, at the last boundary before a component can read it.
  for (const key of Object.keys(doc)) {
    if (KNOWN_KEYS.has(key)) continue;
    onWarn(`storylark: presentation has an unknown key "${key}" — ignoring it. (Written for a newer engine, or a typo.)`);
  }

  return out;
}

/** An object's own defined entries, or {} for anything that is not a plain object. */
function pruned(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * This deployment's presentation. Read at module evaluation, which is safe
 * because the injected `<script>` sits in `<head>` ahead of the module bundle —
 * no round trip, nothing to await, and no flash of the previous arrangement.
 */
export const PRESENTATION: Presentation = resolvePresentation();

/**
 * Brand content nouns — what a content unit is called in the UI. Every
 * user-visible string uses these instead of hardcoding "story"/"chapter"/"book".
 *
 * Lives here rather than in brand.ts because nouns are presentation: the SAME
 * brand can publish a flat story library and a chaptered one, and only this
 * file changes.
 */
export const NOUNS: ContentNouns = PRESENTATION.nouns;

/** "3 chapters" / "1 story" — count with the right brand noun. */
export function countUnits(n: number): string {
  return `${n} ${n === 1 ? NOUNS.unit : NOUNS.unitPlural}`;
}

/**
 * Substitute the noun placeholders in a piece of configurable copy.
 *
 * Empty-state strings are the one place a presentation file supplies text that
 * has to agree with the nouns it also supplies, so the text is a template
 * rather than a literal. Unknown placeholders are left alone: a `{`
 * in someone's prose must survive being rendered.
 */
export function fillCopy(template: string, vars: Record<string, string> = {}): string {
  const all: Record<string, string> = {
    unit: NOUNS.unit,
    unitPlural: NOUNS.unitPlural,
    Unit: NOUNS.Unit,
    UnitPlural: NOUNS.UnitPlural,
    collection: NOUNS.collection ?? '',
    Collection: NOUNS.Collection ?? '',
    ...vars,
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => all[key] ?? match);
}

/**
 * Is a core feature on for this deployment?
 *
 * `fallbackEnabled` is the value core ships the feature with, so a presentation
 * file that predates the feature gets it — rule 1, for features specifically
 * (plan §0b, "How a new feature lands"). Never inline `PRESENTATION.features.x`
 * at a call site; that would make an absent entry mean "off" instead of
 * "core's choice".
 */
export function feature(name: string, fallbackEnabled = true): boolean {
  return PRESENTATION.features[name]?.enabled ?? fallbackEnabled;
}

/** Where the feature asked to be placed, or core's default placement. */
export function featurePlacement(name: string, fallbackPlacement: string): string {
  return PRESENTATION.features[name]?.placement ?? fallbackPlacement;
}

/** Core labels for the nav items. A presentation file overrides these via `nav.labels`. */
const NAV_LABELS: Record<NavItem, string> = {
  home: 'Home',
  library: 'Library',
  nowPlaying: 'Now Playing',
  settings: 'Settings',
  about: 'About',
};

/** The label for one nav item: the brand's override, else the core label. */
export function navLabel(item: NavItem): string {
  return PRESENTATION.nav.labels[item] ?? NAV_LABELS[item];
}

/** The app's internal consumption mode for the contract's `reader.defaultMode`. */
export function readerDefaultMode(): 'read' | 'listen' | 'both' {
  return PRESENTATION.reader.defaultMode === 'readListen' ? 'both' : PRESENTATION.reader.defaultMode;
}

/** True when this library has no collection level — the old `isStoryBrand()`. */
export function isFlat(): boolean {
  return PRESENTATION.layout === 'flat';
}

/** Section titles for a grouped library, per `groupBy`. Exported for Library.tsx. */
export function groupTitle(by: LibraryGroup): string {
  switch (by) {
    case 'collection':
      return NOUNS.Collection ?? 'Collection';
    case 'group':
      return 'Collection';
    case 'timeframe':
      return 'Timeframe';
    default:
      return '';
  }
}

/**
 * Re-stamp an HTML document with a given presentation.
 *
 * Used by the service worker on the app shell it serves out of the precache:
 * that copy carries whatever was injected the day it was cached, while the
 * service worker's own script is re-injected by the platform on every update
 * and therefore holds the current one. Without this, an installed PWA would
 * keep yesterday's tab bar forever after a swap. Mirrors
 * injectPresentationIntoHtml in packages/worker/src/lib/presentation.ts, and is
 * a no-op on a document that carries no injected tag (a static host, where the
 * build-time fallback already agrees).
 *
 * The RESOLVED presentation is not what gets written back: the stated one is.
 * Writing the resolved object would bake this engine's defaults into a cached
 * document, so a later core update with a different default would be overridden
 * by a stale copy of the old one — rule 1 undone by a cache.
 */
export function restampPresentation(html: string, stated: PresentationInput): string {
  const re = new RegExp(`<script id="${PRESENTATION_SCRIPT_ID}">[\\s\\S]*?</script>`);
  if (!re.test(html)) return html;
  const json = JSON.stringify(stated).replace(/</g, '\\u003c');
  return html.replace(re, `<script id="${PRESENTATION_SCRIPT_ID}">self.${PRESENTATION_GLOBAL}=${json};</script>`);
}

/** The presentation exactly as this deployment STATED it — for restampPresentation. */
export const STATED_PRESENTATION: PresentationInput = injected() ?? fallback;
