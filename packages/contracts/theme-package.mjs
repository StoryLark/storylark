// The StoryLark theme package — format, validation, build and read
// (AB#7417 — plan §0c / §0d Phase 4).
//
// ── The format is what a brand folder already is ────────────────────────────
// Phases 0-3 turned brand identity, the stylesheet and presentation into files
// the deployment serves and re-reads per request. A theme therefore already IS
// a folder of files; this format just names them and puts them in a zip so one
// can be moved, versioned, published and installed:
//
//     <id>.storylark-theme.zip
//       package.json        manifest: formatVersion, id, name, version, engine
//       brand.json          identity + look     (brand.schema.json)
//       theme.css           the design tokens
//       presentation.json   optional — the §0b contract (presentation.schema.json)
//       icons/…             the app icons, flattened from assets/icons/
//
// `icons/` rather than `assets/icons/` because that is where the files land in
// a built site (`dist/icons/`) and where every document already points; a
// package should be the shape of the thing being installed, not the shape of
// the source tree it happened to be authored in.
//
// ── The tool's value is validation, not zipping (plan §0c) ──────────────────
// Zipping four files is not a feature. Catching, BEFORE upload, the problems
// that would otherwise surface as a subtly broken live site is:
//
//   • an unknown or missing `contractVersion` — the hard gate
//   • a brand.json that fails brand.schema.json in STRICT mode, so an unknown
//     key is an error here even though the running site would only warn
//   • an id in the manifest that disagrees with the id in brand.json
//   • a missing icon, or one that is present at the wrong pixel size — the
//     failure mode that produces a blurry or blank home-screen icon and gets
//     noticed weeks later, on someone else's phone
//   • a theme.css missing design tokens the app reads, which renders as
//     invisible text or an unstyled control rather than as an error
//   • a theme.css with no alternate-scheme block, or one for the WRONG scheme
//     (a dark-first brand needs `:root[data-theme="light"]`), which makes the
//     theme toggle silently do nothing
//
// ── One implementation, three callers ───────────────────────────────────────
// `npm run package-theme` calls buildThemePackage(); `npm run import-theme` and
// the portal's upload both end at readThemePackage() inside the deployment. The
// CLI and the portal cannot disagree about what a valid package is, because
// neither of them decides.

import { validate, BRAND_SCHEMA, PRESENTATION_SCHEMA, SUPPORTED_CONTRACT_VERSION } from './validate.mjs';
import { zip, unzip, ZipError } from './zip.mjs';

/** Bump only on a breaking reshape of the ARCHIVE layout, not of brand.json. */
export const THEME_PACKAGE_FORMAT = 1;

export const THEME_PACKAGE_EXT = '.storylark-theme.zip';

export const MANIFEST_ENTRY = 'package.json';
export const BRAND_ENTRY = 'brand.json';
export const THEME_CSS_ENTRY = 'theme.css';
export const PRESENTATION_ENTRY = 'presentation.json';
export const ICONS_PREFIX = 'icons/';

/**
 * Ceilings for an uploaded package. A theme is text plus a handful of icons —
 * the real ones in this repo are 60-80KB — so these are generous by an order of
 * magnitude and exist to stop an accident or an attack, not to be tuned.
 */
export const THEME_PACKAGE_LIMITS = {
  maxEntries: 64,
  maxEntryBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

/**
 * The icons a built site actually references, with the size each one is used at.
 *
 * Taken from the real reference set — `brands/storylark/assets/icons/` — filtered
 * to the ones something points at: index.html links favicon.svg and favicon-32,
 * the generated manifest lists icon-192/512/maskable-512, and the service worker
 * uses icon-192 as the push notification icon. A package missing any of these
 * ships a site with a hole in it.
 */
export const REQUIRED_ICONS = {
  'favicon.svg': { kind: 'svg' },
  'favicon-32.png': { kind: 'png', width: 32, height: 32 },
  'icon-192.png': { kind: 'png', width: 192, height: 192 },
  'icon-512.png': { kind: 'png', width: 512, height: 512 },
  'icon-maskable-512.png': { kind: 'png', width: 512, height: 512 },
};

/**
 * Recognised but not required. `favicon-180` is the iOS home-screen icon —
 * absent, iOS downscales icon-192 and the result is soft — and `logo.svg` is
 * carried for a brand that wants a wordmark to hand. Both are in the reference
 * set, so their absence is worth a warning and never worth a refusal.
 */
export const OPTIONAL_ICONS = {
  'favicon-180.png': { kind: 'png', width: 180, height: 180 },
  'logo.svg': { kind: 'svg' },
};

/**
 * The design tokens the app reads. Every one of these is consumed by a
 * stylesheet in storylark-core; a theme that omits one gets the browser's
 * initial value for that custom property, which is "invalid at computed-value
 * time" — i.e. the property it feeds falls back to its own initial, and the
 * result is unreadable text or invisible chrome rather than an error anyone
 * can see.
 */
export const REQUIRED_COLOR_TOKENS = [
  'bg',
  'bg-raised',
  'bg-sunken',
  'text',
  'text-muted',
  'text-faint',
  'accent',
  'accent-strong',
  'rule',
  'link',
  'highlight-word',
  'highlight-block',
];

/** Fonts are set on `:root` only — the alternate scheme inherits them. */
export const REQUIRED_FONT_TOKENS = ['font-display', 'font-headers', 'font-body', 'font-mono'];

export class ThemePackageError extends Error {
  /** @param {string[]} errors @param {string[]} [warnings] */
  constructor(errors, warnings = []) {
    super(errors.join('\n'));
    this.name = 'ThemePackageError';
    this.errors = errors;
    this.warnings = warnings;
  }
}

/**
 * Validate the loose parts of a theme, before they are ever a zip.
 *
 * Separated from the archive handling deliberately: this is the function both
 * `buildThemePackage` (source folder on disk) and `readThemePackage` (uploaded
 * archive) run, so a package that passes on the way out cannot fail on the way
 * in for a reason that has nothing to do with the zip.
 *
 * @param {object} parts
 * @param {unknown} parts.brand              parsed brand.json
 * @param {unknown} [parts.presentation]     parsed presentation.json, or undefined
 * @param {string}  parts.themeCss
 * @param {Map<string, Uint8Array>} parts.icons   bare file name → bytes
 * @param {object}  [opts]
 * @param {string[]} [opts.fontFamilies]     the curated font set, when the caller has it
 * @param {boolean}  [opts.strict]           default true — schema warnings become errors
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateThemeParts(parts, opts = {}) {
  const strict = opts.strict !== false;
  const errors = [];
  const warnings = [];
  const sink = (r) => {
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  };

  sink(validate(parts.brand, BRAND_SCHEMA, { strict, label: BRAND_ENTRY }));
  if (parts.presentation !== undefined) {
    sink(validate(parts.presentation, PRESENTATION_SCHEMA, { strict, label: PRESENTATION_ENTRY }));
  }

  const brand = isObject(parts.brand) ? parts.brand : {};
  sink(validateThemeCss(parts.themeCss, brand, opts.fontFamilies));
  sink(validateIcons(parts.icons));

  return { errors, warnings };
}

/**
 * theme.css checks that a JSON Schema cannot express.
 *
 * Parsed with regexes rather than a CSS parser, and that is a considered
 * choice: the questions asked here are "is this declaration present in this
 * block", which is exactly what a regex answers, and a real parser would be a
 * second dependency in a zero-dependency package for no additional truth. The
 * cost is that a token defined only inside a media query or an @supports block
 * is not seen — which is correctly a warning-worthy authoring style anyway,
 * since the app reads these tokens unconditionally.
 */
export function validateThemeCss(css, brand, fontFamilies) {
  const errors = [];
  const warnings = [];
  if (typeof css !== 'string' || !css.trim()) {
    errors.push(`${THEME_CSS_ENTRY}: empty or missing. A theme without a stylesheet is not a theme.`);
    return { errors, warnings };
  }
  if (/@import\b/.test(css)) {
    errors.push(
      `${THEME_CSS_ENTRY}: contains an @import. A theme must be self-contained — it is served from the deployment's own origin, and an import would fetch styles from somewhere else at page load.`
    );
  }

  const root = blockBody(css, /:root\s*{/);
  if (root === null) {
    errors.push(`${THEME_CSS_ENTRY}: has no \`:root { … }\` block, so it defines none of the design tokens the app reads.`);
    return { errors, warnings };
  }
  const missing = [...REQUIRED_COLOR_TOKENS, ...REQUIRED_FONT_TOKENS].filter((t) => !declares(root, t));
  if (missing.length) {
    errors.push(
      `${THEME_CSS_ENTRY}: \`:root\` does not set ${missing.map((m) => `--${m}`).join(', ')}. The app reads ${missing.length === 1 ? 'that token' : 'those tokens'} directly, so ${missing.length === 1 ? 'it' : 'they'} cannot be left to the browser.`
    );
  }

  // The alternate colour scheme. `defaultTheme` says which one `:root` IS, so
  // the block that has to exist is the OTHER one — getting this backwards is
  // the specific mistake that makes a dark-first theme's light toggle do
  // nothing at all, silently.
  const defaultTheme = brand?.defaultTheme === 'dark' ? 'dark' : 'light';
  const alternate = defaultTheme === 'dark' ? 'light' : 'dark';
  const altBody = blockBody(css, new RegExp(`:root\\[data-theme=["']${alternate}["']\\]\\s*{`));
  if (altBody === null) {
    const wrongWay = blockBody(css, new RegExp(`:root\\[data-theme=["']${defaultTheme}["']\\]\\s*{`));
    errors.push(
      wrongWay === null
        ? `${THEME_CSS_ENTRY}: has no \`:root[data-theme="${alternate}"]\` block, so switching the theme in Settings would change nothing.`
        : `${THEME_CSS_ENTRY}: defines \`:root[data-theme="${defaultTheme}"]\`, but brand.json says defaultTheme is "${defaultTheme}" — so \`:root\` is already the ${defaultTheme} theme and the block that is missing is \`:root[data-theme="${alternate}"]\`.`
    );
  } else {
    const altMissing = REQUIRED_COLOR_TOKENS.filter((t) => !declares(altBody, t));
    if (altMissing.length) {
      errors.push(
        `${THEME_CSS_ENTRY}: \`:root[data-theme="${alternate}"]\` does not set ${altMissing.map((m) => `--${m}`).join(', ')}, so ${altMissing.length === 1 ? 'that token keeps' : 'those tokens keep'} the ${defaultTheme} value when the reader switches themes.`
      );
    }
  }

  if (!/color-scheme\s*:/.test(css)) {
    warnings.push(
      `${THEME_CSS_ENTRY}: sets no \`color-scheme\`. Native controls — select popups, checkboxes, scrollbars — will keep the operating system's scheme and can flash the wrong colour against the theme.`
    );
  }

  // Fonts, when the caller knows the curated set. Never fatal at the deployment
  // end (the runtime already falls back to the theme's own --font-* with a
  // warning), so this is reported the same way in both modes.
  if (Array.isArray(fontFamilies) && fontFamilies.length && isObject(brand?.fonts)) {
    const known = new Set(fontFamilies.map(slug));
    for (const [role, family] of Object.entries(brand.fonts)) {
      if (typeof family !== 'string' || known.has(slug(family))) continue;
      warnings.push(
        `${BRAND_ENTRY}: fonts.${role} = "${family}" is not in the curated font set (${fontFamilies.join(', ')}). No font files ship for it, so the theme's own --font-${role} will stand.`
      );
    }
  }

  return { errors, warnings };
}

/** Every required icon present, at the size it is used at. */
export function validateIcons(icons) {
  const errors = [];
  const warnings = [];
  const map = icons ?? new Map();

  for (const [name, spec] of Object.entries(REQUIRED_ICONS)) {
    const bytes = map.get(name);
    if (!bytes) {
      errors.push(`icons/${name} is missing. ${iconPurpose(name)}`);
      continue;
    }
    errors.push(...checkIcon(name, spec, bytes));
  }
  for (const [name, spec] of Object.entries(OPTIONAL_ICONS)) {
    const bytes = map.get(name);
    if (!bytes) {
      warnings.push(`icons/${name} is absent. ${iconPurpose(name)}`);
      continue;
    }
    errors.push(...checkIcon(name, spec, bytes));
  }
  for (const name of map.keys()) {
    if (name in REQUIRED_ICONS || name in OPTIONAL_ICONS) continue;
    warnings.push(`icons/${name} is not an icon StoryLark references. It is carried along, but nothing will load it.`);
  }
  return { errors, warnings };
}

function checkIcon(name, spec, bytes) {
  if (spec.kind === 'svg') {
    const head = new TextDecoder().decode(bytes.subarray(0, 400)).trimStart();
    if (!head.startsWith('<?xml') && !head.startsWith('<svg') && !head.startsWith('<!--')) {
      return [`icons/${name} is not an SVG document (it does not start with <svg or <?xml).`];
    }
    return [];
  }
  const size = pngSize(bytes);
  if (!size) return [`icons/${name} is not a PNG file.`];
  if (size.width !== spec.width || size.height !== spec.height) {
    return [
      `icons/${name} is ${size.width}×${size.height}; it is used at ${spec.width}×${spec.height}. ${
        size.width < spec.width ? 'Upscaling it would look soft on a retina screen.' : 'Ship it at the stated size.'
      }`,
    ];
  }
  return [];
}

function iconPurpose(name) {
  switch (name) {
    case 'favicon.svg':
      return 'It is the browser tab icon on both the app and the admin page.';
    case 'favicon-32.png':
      return 'It is the tab icon fallback for browsers that do not take an SVG.';
    case 'icon-192.png':
      return 'It is the home-screen icon, the apple-touch-icon, and the push-notification icon.';
    case 'icon-512.png':
      return 'It is the PWA install and splash icon.';
    case 'icon-maskable-512.png':
      return 'It is the Android adaptive icon; without it the launcher crops the square one.';
    case 'favicon-180.png':
      return 'iOS will downscale icon-192 instead, which looks soft.';
    case 'logo.svg':
      return 'It is the brand wordmark a theme can carry for its own use.';
    default:
      return '';
  }
}

/** Width/height from a PNG's IHDR, or null when it isn't a PNG. */
export function pngSize(bytes) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < SIG.length; i++) if (bytes[i] !== SIG[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // IHDR is required by the spec to be the first chunk: length(4) type(4) then
  // width(4) height(4) at byte 16.
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

// ── build ───────────────────────────────────────────────────────────────────

/**
 * Validate, then emit the archive. Refuses to produce a package it would refuse
 * to accept — which is the entire point of having a packaging step at all.
 *
 * @param {object} parts
 * @param {object} parts.brand
 * @param {object} [parts.presentation]
 * @param {string} parts.themeCss
 * @param {Map<string, Uint8Array>} parts.icons
 * @param {string} [parts.version]     package version, default "1.0.0"
 * @param {string} [parts.engine]      the storylark-core version it was made with
 * @param {string[]} [parts.fontFamilies]
 * @param {Date}   [parts.createdAt]   omitted = deterministic output
 * @returns {Promise<{ bytes: Uint8Array, manifest: object, warnings: string[] }>}
 */
export async function buildThemePackage(parts) {
  const { errors, warnings } = validateThemeParts(parts, { fontFamilies: parts.fontFamilies, strict: true });
  if (errors.length) throw new ThemePackageError(errors, warnings);

  const manifest = {
    formatVersion: THEME_PACKAGE_FORMAT,
    id: parts.brand.id,
    name: parts.brand.appName ?? parts.brand.name ?? parts.brand.id,
    version: parts.version ?? '1.0.0',
    contractVersion: parts.brand.contractVersion ?? SUPPORTED_CONTRACT_VERSION,
    hasPresentation: parts.presentation !== undefined,
    ...(parts.engine ? { engine: parts.engine } : {}),
    ...(parts.createdAt ? { createdAt: parts.createdAt.toISOString() } : {}),
  };

  const entries = [
    { name: MANIFEST_ENTRY, data: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: BRAND_ENTRY, data: `${JSON.stringify(parts.brand, null, 2)}\n` },
    // Git normally checks text files out with the platform's native line
    // endings. Canonicalise archive text so the same theme produces the same
    // bytes on Windows, macOS and Linux.
    { name: THEME_CSS_ENTRY, data: canonicalText(parts.themeCss) },
  ];
  if (parts.presentation !== undefined) {
    entries.push({ name: PRESENTATION_ENTRY, data: `${JSON.stringify(parts.presentation, null, 2)}\n` });
  }
  for (const name of [...parts.icons.keys()].sort()) {
    // PNGs are already deflate-compressed internally; re-compressing them makes
    // the entry bigger for no gain, so they are stored.
    const data = parts.icons.get(name);
    entries.push({
      name: ICONS_PREFIX + name,
      data: name.endsWith('.svg') ? canonicalTextBytes(data) : data,
      store: name.endsWith('.png'),
    });
  }

  return { bytes: await zip(entries, { date: parts.createdAt }), manifest, warnings };
}

// ── read ────────────────────────────────────────────────────────────────────

/**
 * Unpack and fully validate an uploaded package.
 *
 * Throws ThemePackageError with EVERY problem found, not just the first — an
 * operator fixing a theme wants the whole list, and re-uploading five times to
 * discover five missing icons is exactly the experience §0c exists to prevent.
 *
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {{ fontFamilies?: string[] }} [opts]
 * @returns {Promise<{ manifest: object, brand: object, presentation: object|undefined, themeCss: string, icons: Map<string, Uint8Array>, warnings: string[] }>}
 */
export async function readThemePackage(bytes, opts = {}) {
  let files;
  try {
    files = await unzip(bytes, THEME_PACKAGE_LIMITS);
  } catch (err) {
    if (err instanceof ZipError) throw new ThemePackageError([err.message]);
    throw err;
  }

  // A package zipped WITH its folder ("wireless/brand.json") is the single most
  // common way a hand-made archive arrives, and refusing it over one path
  // segment would be pedantry. One uniform leading directory is stripped;
  // anything less uniform is a real structural problem and is reported as one.
  const stripped = stripCommonPrefix(files);

  const errors = [];
  const warnings = [];

  const brandRaw = text(stripped.get(BRAND_ENTRY));
  const cssRaw = text(stripped.get(THEME_CSS_ENTRY));
  if (brandRaw === undefined) errors.push(`The archive has no ${BRAND_ENTRY} at its root.`);
  if (cssRaw === undefined) errors.push(`The archive has no ${THEME_CSS_ENTRY} at its root.`);
  if (errors.length) throw new ThemePackageError(errors);

  const brand = parseJson(brandRaw, BRAND_ENTRY, errors);
  const presentationRaw = text(stripped.get(PRESENTATION_ENTRY));
  const presentation = presentationRaw === undefined ? undefined : parseJson(presentationRaw, PRESENTATION_ENTRY, errors);
  const manifestRaw = text(stripped.get(MANIFEST_ENTRY));
  const manifest = manifestRaw === undefined ? undefined : parseJson(manifestRaw, MANIFEST_ENTRY, errors);
  if (errors.length) throw new ThemePackageError(errors);

  const icons = new Map();
  for (const [name, data] of stripped) {
    if (!name.startsWith(ICONS_PREFIX)) continue;
    const bare = name.slice(ICONS_PREFIX.length);
    if (bare.includes('/')) {
      warnings.push(`${name} is in a sub-folder of icons/; nothing loads it.`);
      continue;
    }
    icons.set(bare, data);
  }

  for (const name of stripped.keys()) {
    if (name === MANIFEST_ENTRY || name === BRAND_ENTRY || name === THEME_CSS_ENTRY || name === PRESENTATION_ENTRY) continue;
    if (name.startsWith(ICONS_PREFIX)) continue;
    warnings.push(`"${name}" is not part of the theme package format and was ignored.`);
  }

  // The manifest is optional to READ — a hand-assembled folder is a legitimate
  // way to make one — but if present it must agree with brand.json, because a
  // manifest that disagrees is worse than no manifest at all.
  if (manifest !== undefined) {
    if (isObject(manifest)) {
      if (typeof manifest.formatVersion === 'number' && manifest.formatVersion > THEME_PACKAGE_FORMAT) {
        errors.push(
          `${MANIFEST_ENTRY}: formatVersion ${manifest.formatVersion} was written for a newer StoryLark (this one reads up to ${THEME_PACKAGE_FORMAT}).`
        );
      }
      if (typeof manifest.id === 'string' && isObject(brand) && manifest.id !== brand.id) {
        errors.push(`${MANIFEST_ENTRY}: id "${manifest.id}" does not match ${BRAND_ENTRY} id "${brand.id}".`);
      }
    } else {
      errors.push(`${MANIFEST_ENTRY}: not a JSON object.`);
    }
  } else {
    warnings.push(`No ${MANIFEST_ENTRY} in the archive — installing it anyway, taking the id and name from ${BRAND_ENTRY}.`);
  }

  const parts = validateThemeParts({ brand, presentation, themeCss: cssRaw, icons }, { fontFamilies: opts.fontFamilies, strict: true });
  errors.push(...parts.errors);
  warnings.push(...parts.warnings);
  if (errors.length) throw new ThemePackageError(errors, warnings);

  return {
    manifest: isObject(manifest)
      ? manifest
      : {
          formatVersion: THEME_PACKAGE_FORMAT,
          id: brand.id,
          name: brand.appName ?? brand.name ?? brand.id,
          version: '0.0.0',
          contractVersion: brand.contractVersion,
          hasPresentation: presentation !== undefined,
        },
    brand,
    presentation,
    themeCss: cssRaw,
    icons,
    warnings,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function stripCommonPrefix(files) {
  const names = [...files.keys()];
  if (!names.length) return files;
  const first = names[0].split('/')[0];
  const uniform = names.every((n) => n.startsWith(`${first}/`));
  if (!uniform || !first) return files;
  const out = new Map();
  for (const [name, data] of files) out.set(name.slice(first.length + 1), data);
  return out;
}

function text(bytes) {
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

function canonicalText(value) {
  return value.replace(/\r\n?/g, '\n');
}

function canonicalTextBytes(bytes) {
  return new TextEncoder().encode(canonicalText(new TextDecoder().decode(bytes)));
}

function parseJson(raw, label, errors) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    errors.push(`${label}: not valid JSON (${err.message}).`);
    return undefined;
  }
}

/** `--name:` present in a block body. */
function declares(body, token) {
  return new RegExp(`(^|[;{\\s])--${token}\\s*:`).test(body);
}

/** The body of the first block whose opening matches `open`, brace-balanced. */
function blockBody(css, open) {
  const match = open.exec(css);
  if (!match) return null;
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  return css.slice(start, i - 1);
}

/** Mirrors fontSlug in storylark-core/vite/fonts.mjs. */
function slug(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
