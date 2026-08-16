// Brand identity at response time (AB#7415 — plan §0d Phase 2).
//
// ── The problem this closes ─────────────────────────────────────────────────
// Who a library IS — its names, tagline, author, manifest colours, default
// theme and font choices — was compiled into the JS bundle by the Vite preset.
// Changing any of it meant a rebuild of the whole engine on the operator's own
// machine and a redeploy, which is the exact opposite of the "click to update,
// nothing local, ever" model the plan is built around. It also blocks Phase 5:
// you cannot swap a prebuilt engine bundle underneath a customer while their
// brand is still inside it.
//
// ── What "runtime" means here, precisely ────────────────────────────────────
// NOT "fetched from a config service". Cloudflare Workers have no filesystem
// and no ambient config store, so the brand has to travel WITH the deployment.
// It travels as a static asset instead of as bundle contents:
//
//   dist/brand.json    the live brand identity   — swappable, per deployment
//   dist/theme.css     the live look             — swappable, per deployment
//   dist/fonts.json    the curated font registry — engine data, per build
//
// The platform serving the site reads dist/brand.json on the way out of every
// HTML response and stamps its CURRENT contents into the document. So replacing
// dist/brand.json on an already-deployed site changes the live site — no
// recompile, no new hashed JS chunk, no rebuild of anything. That is the whole
// point of the phase, and it is why the brand is read per request rather than
// captured at boot.
//
// ── The mechanism ───────────────────────────────────────────────────────────
// Deliberately the same shape Phase 1 built for deployment config
// (./deployment.ts), because it is proven and because both platforms already
// route documents through it:
//
//   index.html / admin.html   <script id="storylark-brand">self.__STORYLARK_BRAND__={…}</script>
//                             plus the <title>, rewritten from the live brand
//   sw.js                     the same assignment, as a prelude
//   /theme.css                the brand's CSS, with the live font selection
//                             appended as --font-* declarations
//   /manifest.webmanifest     generated from the live brand, not from the build
//
// A SECOND script tag rather than an extra key inside Phase 1's
// `__STORYLARK_DEPLOYMENT__`, on purpose. Three reasons, in order of weight:
//
//  1. Reshaping the deployment global would break mid-update deployments. An
//     installed PWA's service worker and its precached shell were written by
//     whatever engine was live when they were cached; a document injected with
//     `{deployment:{…}}` served to a service worker that reads
//     `__STORYLARK_DEPLOYMENT__.contentOrigin` loses its content origin, which
//     takes the library offline. Additive globals have no such failure mode.
//  2. The two have different SOURCES and therefore different failure modes.
//     Deployment config comes from environment variables and is validated
//     against operator typos in app settings; brand comes from a JSON file on
//     the deployment's own assets and is validated against a malformed or
//     truncated file. Merging them would merge two unrelated fallback stories.
//  3. The plumbing is shared either way. `run_worker_first`, `serveAsset()` and
//     the Azure claim-before-serveStatic routes decide which URLs reach the
//     injector — not how many tags it writes. Merging saves nothing there.
//
// Both platform entries share THIS module, as with Phase 1: the Cloudflare
// Worker imports it directly, the Azure Node server as `storylark-worker/lib/brand`.

/** Font roles a brand may set. Mirrors FONT_ROLES in storylark-core/vite/fonts.mjs. */
const FONT_ROLES = ['display', 'headers', 'body', 'mono'] as const;
export type FontRole = (typeof FONT_ROLES)[number];

/**
 * Brand identity, as injected — the contents of dist/brand.json, validated.
 *
 * Every key optional for the same reason as DeploymentConfig: an absent key
 * means "this deployment does not state it" and the frontend falls back to the
 * value baked at build. Nothing is defaulted here.
 *
 * Note what is NOT here: `layout` and `nouns`. Those are PRESENTATION, still
 * build-time by design (plan §0d Phase 3). The key list below is the enforced
 * boundary — a brand.json that smuggles a `layout` in gets it dropped, so a
 * half-runtime presentation can never appear by accident.
 */
export interface BrandIdentity {
  id?: string;
  name?: string;
  appName?: string;
  shortName?: string;
  tagline?: string;
  author?: string;
  themeColor?: string;
  backgroundColor?: string;
  defaultTheme?: 'light' | 'dark';
  fonts?: Partial<Record<FontRole, string>>;
}

/** One curated family, as emitted to dist/fonts.json by the core build. */
export interface FontEntry {
  name: string;
  stack: string;
  category: string;
}

/** dist/fonts.json — slug → family. See storylark-core/vite/fonts.mjs. */
export type FontRegistry = Record<string, FontEntry>;

/**
 * The global the injected statement writes.
 *
 * Keep in sync with BRAND_GLOBAL in packages/core/src/brand.ts — core cannot
 * import this module (the frontend must not depend on the worker package) so
 * the name is spelled out in both places on purpose, exactly as Phase 1 does
 * for the deployment global.
 */
export const BRAND_GLOBAL = '__STORYLARK_BRAND__';

/** `id` of the injected `<script>`. Same sync note as above. */
export const BRAND_SCRIPT_ID = 'storylark-brand';

/** Where a built site keeps the three Phase 2 assets. */
export const BRAND_ASSET = '/brand.json';
export const THEME_ASSET = '/theme.css';
export const FONTS_ASSET = '/fonts.json';

const SCRIPT_RE = new RegExp(`<script id="${BRAND_SCRIPT_ID}">[\\s\\S]*?</script>`);
const PRELUDE_RE = new RegExp(`^self\\.${BRAND_GLOBAL}=.*\\n`);

/**
 * `<title data-storylark-title="app">` / `"admin"` — the marker the build
 * writes so the injector can retitle a document without knowing which page it
 * is holding. Without it, stamping the app title onto admin.html would silently
 * drop the "Admin — " prefix on every operator page load.
 */
const TITLE_RE = /<title data-storylark-title="(app|admin)">[\s\S]*?<\/title>/;

/**
 * The block appended to theme.css carrying the live font selection. Marked so
 * the injector can replace its own previous output: the build bakes one into
 * dist/theme.css for contexts that never reach an injector (`vite preview`, a
 * bare static host), and re-appending on top of it would leave two blocks with
 * the losing one still in the file.
 */
const FONT_BLOCK_OPEN = '/* storylark:fonts */';
const FONT_BLOCK_CLOSE = '/* /storylark:fonts */';
const FONT_BLOCK_RE = /\/\* storylark:fonts \*\/[\s\S]*?\/\* \/storylark:fonts \*\//g;

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Parse and validate the deployment's brand.json.
 *
 * Validation happens HERE rather than through brand.schema.json for the same
 * reasons Phase 1 validates deployment config by hand: validate.mjs is Node-only
 * ESM that reads schema files off disk, which no Worker can do. What is worth
 * catching at this boundary is an operator hand-editing a live file — so a bad
 * VALUE is warned about and OMITTED (the frontend then falls back to the
 * build-time value for that one key), and only unparseable JSON gives up on the
 * file entirely. A stray typo in `themeColor` must not blank out the app name.
 *
 * Returns undefined when there is nothing usable, which the callers treat as
 * "this deployment ships no brand asset" and skip injection for — an older
 * build with no dist/brand.json keeps working on a newer engine.
 */
export function readBrandAsset(
  text: string,
  onWarn: (message: string) => void = (m) => console.warn(m)
): BrandIdentity | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    onWarn(
      `storylark: brand.json is not valid JSON (${(err as Error).message}) — serving the brand baked in at build until it is fixed.`
    );
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    onWarn('storylark: brand.json is not a JSON object — serving the brand baked in at build until it is fixed.');
    return undefined;
  }
  const doc = raw as Record<string, unknown>;
  const brand: BrandIdentity = {};

  for (const key of ['id', 'name', 'appName', 'shortName', 'tagline', 'author'] as const) {
    const value = text_(doc[key], key, onWarn);
    if (value !== undefined) brand[key] = value;
  }
  for (const key of ['themeColor', 'backgroundColor'] as const) {
    const value = text_(doc[key], key, onWarn);
    if (value === undefined) continue;
    if (!HEX.test(value)) {
      onWarn(`storylark: brand.json ${key}="${value}" is not a hex colour — ignoring it and using the build-time value.`);
      continue;
    }
    brand[key] = value;
  }
  if (doc.defaultTheme !== undefined) {
    if (doc.defaultTheme === 'light' || doc.defaultTheme === 'dark') {
      brand.defaultTheme = doc.defaultTheme;
    } else {
      onWarn(
        `storylark: brand.json defaultTheme=${JSON.stringify(doc.defaultTheme)} is not "light" or "dark" — ignoring it and using the build-time value.`
      );
    }
  }
  if (doc.fonts !== undefined) {
    if (doc.fonts === null || typeof doc.fonts !== 'object' || Array.isArray(doc.fonts)) {
      onWarn('storylark: brand.json `fonts` is not an object — ignoring it and using the build-time font selection.');
    } else {
      const fonts: Partial<Record<FontRole, string>> = {};
      for (const role of FONT_ROLES) {
        const value = text_((doc.fonts as Record<string, unknown>)[role], `fonts.${role}`, onWarn);
        if (value !== undefined) fonts[role] = value;
      }
      if (Object.keys(fonts).length) brand.fonts = fonts;
    }
  }

  // Rule 2 of the contract, enforced at the serve boundary rather than only at
  // build: an unknown key is ignored with a warning. `layout`/`nouns` get a
  // pointed one — they are the keys most likely to be tried here, and silently
  // dropping them would look like a bug rather than like Phase 3 not existing yet.
  for (const key of Object.keys(doc)) {
    if (KNOWN_BRAND_KEYS.has(key)) continue; // known — accepted above, or already warned about
    if (key === 'layout' || key === 'nouns') {
      onWarn(
        `storylark: brand.json "${key}" is presentation, not identity — it lives in presentation/<id>/presentation.json and is still applied at build time. Ignoring it here.`
      );
      continue;
    }
    onWarn(`storylark: brand.json has an unknown key "${key}" — ignoring it.`);
  }

  return Object.keys(brand).length ? brand : undefined;
}

const KNOWN_BRAND_KEYS: ReadonlySet<string> = new Set([
  'contractVersion',
  'id',
  'name',
  'appName',
  'shortName',
  'tagline',
  'author',
  'themeColor',
  'backgroundColor',
  'defaultTheme',
  'fonts',
]);

/** A non-empty string, or a warning and undefined. Trailing `_` avoids shadowing DOM `text`. */
function text_(value: unknown, name: string, onWarn: (m: string) => void): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    onWarn(`storylark: brand.json ${name} is not a string — ignoring it and using the build-time value.`);
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined; // an empty string states nothing; keep the built-in
  return trimmed;
}

/** Parse dist/fonts.json. Engine data, so a bad one is a bug, not operator input. */
export function readFontRegistry(
  text: string,
  onWarn: (message: string) => void = (m) => console.warn(m)
): FontRegistry | undefined {
  try {
    const doc = JSON.parse(text) as { families?: FontRegistry };
    const families = doc?.families;
    if (families && typeof families === 'object' && !Array.isArray(families)) return families;
  } catch {
    // fall through
  }
  onWarn('storylark: fonts.json is missing or malformed — the theme keeps its own --font-* values.');
  return undefined;
}

/**
 * `self.__STORYLARK_BRAND__={…};` — the one statement, shared by the HTML tag
 * and the service-worker prelude.
 *
 * `<` is escaped for the same reason as in ./deployment.ts: this string is
 * emitted inside a `<script>` element, where a literal `</script>` inside a JSON
 * string value would end the element early. A tagline is free text typed by a
 * human, so this is a real case here, not a theoretical one.
 */
export function brandStatement(brand: BrandIdentity): string {
  const json = JSON.stringify(brand).replace(/</g, '\\u003c');
  return `self.${BRAND_GLOBAL}=${json};`;
}

/** The `<script>` element injected into a document. */
export function brandScriptTag(brand: BrandIdentity): string {
  return `<script id="${BRAND_SCRIPT_ID}">${brandStatement(brand)}</script>`;
}

/**
 * Stamp the brand into an HTML document: the global, then the `<title>`.
 *
 * The script goes immediately after `<head>`, ahead of the module bundle, so
 * the app reads the live brand during its own module evaluation — no round
 * trip, nothing to await, and no flash of the previous brand's name. Idempotent.
 *
 * The title is rewritten separately because it is the one piece of brand that
 * has to be right BEFORE any JavaScript runs: it is what a browser shows in the
 * tab while the bundle is still downloading, and what it uses to name a
 * bookmark or a "add to home screen" shortcut created from a slow connection.
 */
export function injectBrandIntoHtml(html: string, brand: BrandIdentity): string {
  const tag = brandScriptTag(brand);
  let out = SCRIPT_RE.test(html) ? html.replace(SCRIPT_RE, tag) : insertAfterHead(html, tag);
  out = out.replace(TITLE_RE, (match, kind: string) => {
    const appName = brand.appName;
    if (!appName) return match; // this deployment states no app name — leave the build's title
    const title = kind === 'admin' ? `Admin — ${appName}` : appName;
    return `<title data-storylark-title="${kind}">${escapeHtml(title)}</title>`;
  });
  return out;
}

function insertAfterHead(html: string, tag: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Stamp the brand into the service worker script.
 *
 * The service worker needs it for two things: the push notification title (it
 * composes "<appName>: <name>" with no document to ask), and re-stamping the
 * precached app shell — the precache is only refetched when the BUILD changes,
 * so without this an installed PWA would keep showing yesterday's brand forever
 * after a swap. See packages/core/src/sw.ts.
 */
export function injectBrandIntoScript(js: string, brand: BrandIdentity): string {
  return `${brandStatement(brand)}\n${js.replace(PRELUDE_RE, '')}`;
}

/**
 * theme.css with the brand's font selection appended as `--font-*` declarations.
 *
 * Why append to the stylesheet instead of injecting a `<style>` into the
 * document: a `<style>` in the shell would be precached with the shell and go
 * stale on an installed PWA, which would then need re-stamping in the service
 * worker — a second implementation of this function, in a second package, that
 * has to agree with this one byte for byte. Putting the declarations at the end
 * of the stylesheet the browser already has to fetch means there is exactly one
 * place that computes them, no extra request, and no render-blocking gap:
 * `<link rel="stylesheet">` blocks paint already, so the fonts are settled
 * before the first frame either way.
 *
 * Last-wins is the mechanism: theme.css sets its own `--font-*` on `:root`, and
 * this block, appended after, overrides exactly the roles the brand names. A
 * role the brand leaves out keeps the theme's value. A family that is not in
 * the curated set keeps it too, with a warning — the alternative is setting a
 * property to a font whose files were never shipped, which renders as the
 * browser default and looks like the theme is broken.
 */
export function themeCssWithFonts(
  css: string,
  brand: BrandIdentity | undefined,
  registry: FontRegistry | undefined,
  onWarn: (message: string) => void = (m) => console.warn(m)
): string {
  const stripped = css.replace(FONT_BLOCK_RE, '').trimEnd();
  const block = fontBlock(brand?.fonts, registry, onWarn);
  return block ? `${stripped}\n${block}\n` : `${stripped}\n`;
}

/** The marked `:root{…}` block, or '' when there is nothing to say. */
export function fontBlock(
  fonts: Partial<Record<FontRole, string>> | undefined,
  registry: FontRegistry | undefined,
  onWarn: (message: string) => void = (m) => console.warn(m)
): string {
  if (!fonts || !registry) return '';
  const decls: string[] = [];
  for (const role of FONT_ROLES) {
    const family = fonts[role];
    if (!family) continue;
    const entry = registry[fontSlug(family)];
    if (!entry) {
      onWarn(
        `storylark: brand.json fonts.${role}="${family}" is not in the curated font set (${Object.values(registry)
          .map((f) => f.name)
          .join(', ')}) — no font files ship for it, so the theme's own --font-${role} stands. Custom fonts are a later phase.`
      );
      continue;
    }
    decls.push(`  --font-${role}: ${entry.stack};`);
  }
  if (!decls.length) return '';
  return `${FONT_BLOCK_OPEN}\n:root {\n${decls.join('\n')}\n}\n${FONT_BLOCK_CLOSE}`;
}

/** Mirrors fontSlug in storylark-core/vite/fonts.mjs — same rule, spelled twice for the same reason as BRAND_GLOBAL. */
function fontSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * manifest.webmanifest, generated from the live brand.
 *
 * The build still emits a static one (for `vite preview` and static hosting),
 * but on a real deployment this is what answers the request, so a swapped
 * brand.json changes the installed app's name and colours on the next install
 * — no rebuild. Icon PATHS are fixed and the icon FILES are still build-time
 * assets: swapping the pictures means replacing dist/icons/*.png, which needs
 * no code and is why it is not modelled here.
 *
 * `brand` is a partial: any key it omits falls back to `baked`, the values the
 * build put in the static manifest. That keeps a half-filled brand.json from
 * producing a manifest with `undefined` in it.
 */
export function manifestFromBrand(brand: BrandIdentity, baked?: Record<string, unknown>): Record<string, unknown> {
  const appName = brand.appName ?? (typeof baked?.short_name === 'string' ? baked.short_name : 'StoryLark');
  const name = brand.name ? `${appName}: ${brand.name}` : (baked?.name as string) ?? appName;
  return {
    name,
    short_name: brand.shortName ?? appName,
    description: brand.tagline ?? (baked?.description as string) ?? '',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: brand.themeColor ?? (baked?.theme_color as string) ?? '#ffffff',
    background_color: brand.backgroundColor ?? (baked?.background_color as string) ?? '#ffffff',
    icons: (baked?.icons as unknown[]) ?? [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
