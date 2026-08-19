// Reader-choosable LOOKS — the gallery's sample themes, offered in Settings
// (AB#7412).
//
// ── What this is, and what it deliberately is not ───────────────────────────
// A "theme" in this engine is a whole BRAND: brand.json + theme.css + icons,
// imported as a package, versioned, one per deployment (lib/theme-store.ts in
// the worker). That stays exactly as it was. This is a much smaller thing
// sitting on top of it: the CSS custom-property VALUES — the colours and the
// font stacks — of a handful of looks we already ship, so an individual reader
// can read in Nebula's palette on a Loveletter deployment without the
// deployment's identity moving an inch.
//
// The line is drawn at identity, and it is drawn hard:
//
//   a look changes    --bg, --text, --accent, --font-*, color-scheme …
//   a look NEVER      appName, shortName, tagline, author, themeColor,
//                     backgroundColor, the PWA manifest, the icons, the
//                     installed theme package, or what any OTHER reader sees.
//
// So a reader's choice cannot reach `themes/active.json`, cannot reach
// /manifest.webmanifest, and cannot be mistaken for installing a theme. It is a
// display preference, stored beside text size and line spacing, applied the
// same way and to the same element.
//
// ── Why inline custom properties rather than a stylesheet swap ──────────────
// The alternative was fetching another theme.css and swapping the <link>. That
// would have meant a network round trip and a flash of the old palette on every
// change, a second stylesheet in the cache story, and — worst — a second thing
// that can set --font-* while the serving platform is already appending a
// `:root { --font-* }` block to /theme.css from the LIVE brand (see
// themeCssWithFonts in the worker). An inline declaration on <html> wins over
// every :root rule by specificity, including that appended block, with no
// fetch and no flash. Clearing it puts the deployment's own stylesheet back in
// charge with nothing left behind — which is what makes "Brand default" a real
// option and not a sixth theme.
//
// ── Why both variants are stored complete ───────────────────────────────────
// A brand's theme.css states one variant on bare `:root` and the OTHER as a
// `:root[data-theme="…"]` override, and which one is which differs per brand:
// brands/storylark and brands/loveletter are light-first, brands/nebula and
// brands/wireless are dark-first (a dark-first brand has to be dark before the
// bundle has run or every cold load flashes white). Layering an override on an
// inline base would reproduce that asymmetry inside JavaScript. Instead each
// look carries a COMPLETE token set per variant, flattened here once, so
// applying one is a plain assignment and light/dark keeps working inside every
// look without knowing which way round its stylesheet was written.
//
// The values below are the real brands/<id>/theme.css files, flattened. They
// are not maintained by hand against them: packages/worker/test/reader-theme.test.mjs
// re-parses every one of those stylesheets and fails if a single token here has
// drifted, so retuning a sample brand's colours and forgetting this file is a
// red test rather than a look that quietly disagrees with the theme it is named
// after.

/** A look's id — also the `brands/<id>` folder the tokens were taken from. */
export type ReaderThemeId = 'storylark' | 'loveletter' | 'nebula' | 'weatherglass' | 'wireless';

/** Light or dark. The existing per-reader `settings.theme`, once `auto` is resolved. */
export type ThemeVariant = 'light' | 'dark';

/** CSS property name → value. Custom properties plus `color-scheme`. */
export type ThemeTokens = Readonly<Record<string, string>>;

export interface ReaderTheme {
  id: ReaderThemeId;
  /** What the picker calls it. The look's own name, not the brand's app name. */
  label: string;
  /** One line of why it looks the way it does, for the picker's help text. */
  blurb: string;
  /**
   * The variant this look was designed around — what `theme: 'auto'` resolves
   * to while it is active. Taken from which block the stylesheet puts on bare
   * `:root`, which is the same thing brand.json's `defaultTheme` states.
   */
  defaultVariant: ThemeVariant;
  light: ThemeTokens;
  dark: ThemeTokens;
}

/**
 * What a reader's `settings.readerTheme` holds when they have not chosen a
 * look, and the value of the picker's first entry: the deployment's own
 * theme.css, untouched.
 *
 * Empty string rather than a word, matching `settings.narratorVoice`, whose ''
 * means the same kind of thing ("whatever the library ships").
 */
export const BRAND_LOOK = '';

/**
 * Every CSS property a look sets.
 *
 * Kept as one list rather than derived from the active look, because CLEARING
 * has to remove what the PREVIOUS look set, and a look that stated one token
 * fewer than its predecessor would otherwise leave that token stuck on. All
 * five state the same seventeen today; the list is what guarantees the
 * behaviour when one of them stops.
 */
export const THEME_TOKEN_NAMES: readonly string[] = [
  'color-scheme',
  '--bg',
  '--bg-raised',
  '--bg-sunken',
  '--text',
  '--text-muted',
  '--text-faint',
  '--accent',
  '--accent-strong',
  '--rule',
  '--link',
  '--font-display',
  '--font-headers',
  '--font-body',
  '--font-mono',
  '--highlight-word',
  '--highlight-block',
];

/** The bundled looks, in the order the picker offers them. */
export const READER_THEMES: readonly ReaderTheme[] = [
  {
    id: 'storylark',
    label: 'Daybreak',
    blurb: 'Warm paper and dawn teal, set in a reading serif.',
    defaultVariant: 'light',
    light: {
      'color-scheme': 'light',
      '--bg': '#FBF8F2',
      '--bg-raised': '#FFFDF7',
      '--bg-sunken': '#F1EADD',
      '--text': '#232020',
      '--text-muted': '#635C54',
      '--text-faint': '#635C54',
      '--accent': '#0E7C7B',
      '--accent-strong': '#0A5F5E',
      '--rule': '#E6DFD2',
      '--link': '#0E7C7B',
      '--font-display': '"Newsreader", Georgia, serif',
      '--font-headers': '"Newsreader", Georgia, serif',
      '--font-body': '"Newsreader", Georgia, serif',
      '--font-mono': '"Inter", system-ui, sans-serif',
      '--highlight-word': 'rgba(224, 164, 35, 0.22)',
      '--highlight-block': 'rgba(224, 164, 35, 0.5)',
    },
    dark: {
      'color-scheme': 'dark',
      '--bg': '#14171A',
      '--bg-raised': '#1D2226',
      '--bg-sunken': '#0E1113',
      '--text': '#F1ECE3',
      '--text-muted': '#B8B0A4',
      '--text-faint': '#B8B0A4',
      '--accent': '#35B7B4',
      '--accent-strong': '#57C9C6',
      '--rule': '#2C3237',
      '--link': '#57C9C6',
      '--font-display': '"Newsreader", Georgia, serif',
      '--font-headers': '"Newsreader", Georgia, serif',
      '--font-body': '"Newsreader", Georgia, serif',
      '--font-mono': '"Inter", system-ui, sans-serif',
      '--highlight-word': 'rgba(240, 190, 80, 0.25)',
      '--highlight-block': 'rgba(240, 190, 80, 0.5)',
    },
  },
  {
    id: 'loveletter',
    label: 'Loveletter',
    blurb: 'Laid paper gone rose, plum-black ink, one carmine seal.',
    defaultVariant: 'light',
    light: {
      'color-scheme': 'light',
      '--bg': '#F8EFF0',
      '--bg-raised': '#FEF8F7',
      '--bg-sunken': '#EDDFE1',
      '--text': '#2E2028',
      '--text-muted': '#6D5761',
      '--text-faint': '#6D5761',
      '--accent': '#A83250',
      '--accent-strong': '#7F1F39',
      '--rule': '#E4D1D5',
      '--link': '#A83250',
      '--font-display': '"Cormorant Garamond", Garamond, Georgia, serif',
      '--font-headers': '"Cormorant Garamond", Garamond, Georgia, serif',
      '--font-body': '"Lora", Georgia, Cambria, "Times New Roman", serif',
      '--font-mono': '"Inter", system-ui, sans-serif',
      '--highlight-word': 'rgba(124, 96, 176, 0.2)',
      '--highlight-block': 'rgba(124, 96, 176, 0.42)',
    },
    dark: {
      'color-scheme': 'dark',
      '--bg': '#1E151A',
      '--bg-raised': '#291E23',
      '--bg-sunken': '#150E11',
      '--text': '#F3E5E8',
      '--text-muted': '#C0A8B0',
      '--text-faint': '#C0A8B0',
      '--accent': '#E8768F',
      '--accent-strong': '#F49AAC',
      '--rule': '#3A2830',
      '--link': '#F49AAC',
      '--font-display': '"Cormorant Garamond", Garamond, Georgia, serif',
      '--font-headers': '"Cormorant Garamond", Garamond, Georgia, serif',
      '--font-body': '"Lora", Georgia, Cambria, "Times New Roman", serif',
      '--font-mono': '"Inter", system-ui, sans-serif',
      '--highlight-word': 'rgba(166, 138, 220, 0.26)',
      '--highlight-block': 'rgba(166, 138, 220, 0.5)',
    },
  },
  {
    id: 'nebula',
    label: 'Nebula',
    blurb: 'A glass-plate archive: emulsion grey, bone type, reflection blue.',
    defaultVariant: 'dark',
    light: {
      'color-scheme': 'light',
      '--bg': '#EDEEF2',
      '--bg-raised': '#F8F9FC',
      '--bg-sunken': '#DFE1E9',
      '--text': '#171A21',
      '--text-muted': '#565B69',
      '--text-faint': '#565B69',
      '--accent': '#33528F',
      '--accent-strong': '#223C6E',
      '--rule': '#D3D7E1',
      '--link': '#33528F',
      '--font-display': '"Inter", system-ui, "Segoe UI", sans-serif',
      '--font-headers': '"Inter", system-ui, "Segoe UI", sans-serif',
      '--font-body': '"Newsreader", Georgia, Cambria, "Times New Roman", serif',
      '--font-mono': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
      '--highlight-word': 'rgba(198, 88, 108, 0.2)',
      '--highlight-block': 'rgba(198, 88, 108, 0.42)',
    },
    dark: {
      'color-scheme': 'dark',
      '--bg': '#171A21',
      '--bg-raised': '#202631',
      '--bg-sunken': '#0D1015',
      '--text': '#E9E6DF',
      '--text-muted': '#A2A5B1',
      '--text-faint': '#A2A5B1',
      '--accent': '#86A8DE',
      '--accent-strong': '#A9C4EF',
      '--rule': '#2B313D',
      '--link': '#A9C4EF',
      '--font-display': '"Inter", system-ui, "Segoe UI", sans-serif',
      '--font-headers': '"Inter", system-ui, "Segoe UI", sans-serif',
      '--font-body': '"Newsreader", Georgia, Cambria, "Times New Roman", serif',
      '--font-mono': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
      '--highlight-word': 'rgba(216, 108, 124, 0.26)',
      '--highlight-block': 'rgba(216, 108, 124, 0.5)',
    },
  },
  {
    id: 'weatherglass',
    label: 'Weatherglass',
    blurb: 'Almanac pulp, cold ink, admiralty chart blue.',
    defaultVariant: 'light',
    light: {
      'color-scheme': 'light',
      '--bg': '#E9EBE5',
      '--bg-raised': '#F3F4EF',
      '--bg-sunken': '#DBDED5',
      '--text': '#1B2327',
      '--text-muted': '#566065',
      '--text-faint': '#566065',
      '--accent': '#21506E',
      '--accent-strong': '#163D56',
      '--rule': '#C7CDC2',
      '--link': '#21506E',
      '--font-display': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
      '--font-headers': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
      '--font-body': '"Lora", Georgia, Cambria, "Times New Roman", serif',
      '--font-mono': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
      '--highlight-word': 'rgba(184, 74, 42, 0.2)',
      '--highlight-block': 'rgba(184, 74, 42, 0.42)',
    },
    dark: {
      'color-scheme': 'dark',
      '--bg': '#0F1519',
      '--bg-raised': '#171F24',
      '--bg-sunken': '#090E11',
      '--text': '#DCE4E2',
      '--text-muted': '#98A5A6',
      '--text-faint': '#98A5A6',
      '--accent': '#6FA6C6',
      '--accent-strong': '#92C1DC',
      '--rule': '#232E33',
      '--link': '#92C1DC',
      '--font-display': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
      '--font-headers': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
      '--font-body': '"Lora", Georgia, Cambria, "Times New Roman", serif',
      '--font-mono': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
      '--highlight-word': 'rgba(226, 122, 84, 0.24)',
      '--highlight-block': 'rgba(226, 122, 84, 0.46)',
    },
  },
  {
    id: 'wireless',
    label: 'Wireless',
    blurb: 'Bakelite and walnut, dial-glass cream, one amber lamp.',
    defaultVariant: 'dark',
    light: {
      'color-scheme': 'light',
      '--bg': '#EDE3D1',
      '--bg-raised': '#F6EFE1',
      '--bg-sunken': '#DFD2BA',
      '--text': '#2A1F16',
      '--text-muted': '#6B5842',
      '--text-faint': '#6B5842',
      '--accent': '#94540F',
      '--accent-strong': '#7A4408',
      '--rule': '#D6C6A9',
      '--link': '#94540F',
      '--font-display': '"Cinzel", Optima, Georgia, serif',
      '--font-headers': '"Cinzel", Optima, Georgia, serif',
      '--font-body': '"Newsreader", Georgia, Cambria, "Times New Roman", serif',
      '--font-mono': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
      '--highlight-word': 'rgba(176, 56, 38, 0.2)',
      '--highlight-block': 'rgba(176, 56, 38, 0.42)',
    },
    dark: {
      'color-scheme': 'dark',
      '--bg': '#191310',
      '--bg-raised': '#241B16',
      '--bg-sunken': '#100B09',
      '--text': '#F0E3CC',
      '--text-muted': '#B8A78C',
      '--text-faint': '#B8A78C',
      '--accent': '#D89A2C',
      '--accent-strong': '#F0B851',
      '--rule': '#3A2C22',
      '--link': '#F0B851',
      '--font-display': '"Cinzel", Optima, Georgia, serif',
      '--font-headers': '"Cinzel", Optima, Georgia, serif',
      '--font-body': '"Newsreader", Georgia, Cambria, "Times New Roman", serif',
      '--font-mono': '"IBM Plex Mono", ui-monospace, Consolas, monospace',
      '--highlight-word': 'rgba(198, 74, 52, 0.28)',
      '--highlight-block': 'rgba(198, 74, 52, 0.5)',
    },
  },
];

/** Every bundled look's id, in picker order. */
export const READER_THEME_IDS: readonly ReaderThemeId[] = READER_THEMES.map((t) => t.id);

/** One look by id, or undefined for `BRAND_LOOK` and for anything unrecognised. */
export function readerTheme(id: string | null | undefined): ReaderTheme | undefined {
  return READER_THEMES.find((t) => t.id === id);
}

/**
 * The presentation `readerTheme` group, as a file may state it.
 *
 * `options` is which looks the picker offers; `forced` is the admin's override.
 * Both are checked here rather than trusted, because presentation values arrive
 * from a hand-editable file and the injector deliberately polices SHAPE only —
 * "core polices meaning" (packages/worker/src/lib/presentation.ts).
 */
export interface ReaderThemeConfig {
  options: ReaderThemeId[];
  forced: ReaderThemeId | null;
}

/**
 * Core's default: every bundled look offered, nothing forced.
 *
 * ── The one place this phase knowingly bends "a core default matches what the
 * code did before" ─────────────────────────────────────────────────────────
 * DEFAULT_PRESENTATION's rule is that a new key's default must reproduce
 * existing behaviour, so updating core cannot change a live deployment. This
 * key defaults to ON instead, and the reasoning is the product owner's own
 * request — the sample themes should be offered by default — plus the fact that
 * what it changes is strictly an OFFER: one extra select on the Settings
 * screen, whose initial value is "Brand default", which is exactly the look
 * every reader already has. Nothing about the library's appearance moves until
 * a reader deliberately moves it, and nothing at all moves for a reader who
 * never opens Settings. That is a different class of change from re-ordering a
 * tab bar underneath somebody.
 *
 * The escape hatch is real and is the same one `settings.theme` already gives:
 * `{"readerTheme": {"options": []}}` removes the picker entirely, and
 * `{"settings": {"theme": false}}` removes the whole Theme control as before.
 */
export const DEFAULT_READER_THEME: ReaderThemeConfig = {
  options: [...READER_THEME_IDS],
  forced: null,
};

/** What Settings should render, and what applyReaderTheme should apply. */
export interface ResolvedReaderTheme {
  /** The looks the reader may pick between. Empty = no picker at all. */
  options: ReaderTheme[];
  /** The look in force right now, or null for the deployment's own theme.css. */
  active: ReaderTheme | null;
  /** True when the admin has fixed it and the reader's own choice does not apply. */
  forced: boolean;
}

/**
 * Decide which look a reader actually gets.
 *
 * The whole point of this function is the order of the two questions, and it is
 * why the reader's stored choice is not read first: an admin-forced look must
 * beat a preference that was saved before the admin forced anything. Hiding the
 * picker while a stale localStorage value carried on being applied would be a
 * setting that appears to work and does not, which is worse than not shipping
 * it. So `forced` short-circuits, and `chosen` is never consulted in that case.
 *
 * A `chosen` look the admin has since removed from `options` also falls back to
 * the brand's own look, for the same reason: `options` is the offer, and a
 * preference for something no longer offered is not a licence to keep serving
 * it.
 */
export function resolveReaderTheme(
  config: ReaderThemeConfig,
  chosen: string | null | undefined
): ResolvedReaderTheme {
  const forcedLook = readerTheme(config.forced);
  if (forcedLook) return { options: [forcedLook], active: forcedLook, forced: true };

  // Unknown ids are dropped rather than rejected — a presentation file naming a
  // look a future engine ships must not empty the picker on this one.
  const offered = READER_THEMES.filter((t) => (Array.isArray(config.options) ? config.options : []).includes(t.id));
  const chosenLook = offered.find((t) => t.id === chosen) ?? null;
  return { options: offered, active: chosenLook, forced: false };
}

/** Which of light/dark applies, given the reader's setting and the active look. */
export function resolveVariant(
  setting: 'light' | 'dark' | 'auto',
  active: ReaderTheme | null,
  brandDefault: ThemeVariant
): ThemeVariant {
  if (setting === 'light' || setting === 'dark') return setting;
  // 'auto' means "whatever this look was designed as". With no look chosen that
  // is still the brand's own `defaultTheme`, so nothing changes for a reader who
  // never picks one.
  return active ? active.defaultVariant : brandDefault;
}

/** The minimal surface applyReaderTheme needs — an element's inline style. */
export interface StyleTarget {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
}

/**
 * Put a look on an element (in practice `<html>`), or take every trace of one
 * off it.
 *
 * Always clears first, then sets. Clearing unconditionally is what makes
 * switching back to "Brand default" — and switching between two looks that
 * disagree about which tokens they state — leave nothing behind for the
 * deployment's own stylesheet to fight with.
 */
export function applyReaderTheme(target: StyleTarget, look: ReaderTheme | null, variant: ThemeVariant): void {
  for (const name of THEME_TOKEN_NAMES) target.style.removeProperty(name);
  if (!look) return;
  const tokens = variant === 'dark' ? look.dark : look.light;
  for (const [name, value] of Object.entries(tokens)) target.style.setProperty(name, value);
}
