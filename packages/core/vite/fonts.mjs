// The curated font set (AB#7415 — plan §0d Phase 2).
//
// ── Why a curated set at all ────────────────────────────────────────────────
// Phase 2 makes brand identity runtime data: swap brands/<id>/brand.json on a
// deployed site and the next request serves the new brand, with no rebuild.
// Fonts are the one part of a brand that cannot follow that rule for free,
// because a font is BINARY FILES, not a string. A brand that names a family
// whose .woff2 was never shipped gets the generic fallback, however correct the
// injection is.
//
// So the set is fixed at build time and the SELECTION is runtime: every family
// below ships its @font-face CSS and its files with the engine (once — the same
// files for every brand), and `fonts` in brand.json picks which of them the
// `--font-*` CSS custom properties resolve to. Changing the pick is a file
// swap; adding a family to the set is a core release. That is exactly the trade
// the plan calls for — "ship a curated font set that a brand selects by name
// via CSS custom properties, and defer arbitrary custom font upload to a later
// phase".
//
// ── The two consumers, one registry ─────────────────────────────────────────
// This file is the single source of truth, read by two places that never meet:
//
//   the build   vite/index.mjs — turns `files` into the @fontsource imports
//               that bundle every family, and emits dist/fonts.json
//   the server  packages/worker/src/lib/brand.ts — reads dist/fonts.json and
//               turns the live brand's `fonts` into `--font-*` declarations
//               appended to /theme.css at response time
//
// The server side deliberately reads the EMITTED dist/fonts.json rather than
// importing this module: storylark-worker must not depend on storylark-core,
// and shipping the registry as a build output means the stacks the server
// serves are always the stacks whose files that same build shipped. A registry
// duplicated in the worker package could drift; a build artefact cannot.
//
// ── Adding a family ─────────────────────────────────────────────────────────
// Add `@fontsource/<pkg>` to packages/core/package.json dependencies, add an
// entry here, and mention it in docs/build-your-own-theme.md. Nothing else —
// no per-brand configuration, and no change to the worker.

/**
 * @typedef {object} CuratedFont
 * @property {string} name      Family name as a brand writes it in `fonts`.
 * @property {string} pkg       @fontsource package (also the slug used to match).
 * @property {'serif'|'sans'|'display'|'mono'} category
 * @property {string} stack     The full CSS font stack, family first. This is
 *   what a `--font-*` custom property is set to, so it carries its own
 *   fallbacks — a reader whose download of the woff2 failed still gets a face
 *   of the right kind rather than the browser default.
 * @property {string[]} files   @fontsource CSS entry points to import. A file a
 *   family does not publish is skipped at build (resolve fails), so listing
 *   400-italic for a family without italics is harmless.
 */

/**
 * Weights, per kind of family. Text faces carry italics because body copy needs
 * them; display and mono faces do not (Cinzel publishes no italic at all, and
 * italic code is nobody's idea of a good time).
 */
const TEXT_FILES = ['400.css', '400-italic.css', '600.css', '700.css'];
const DISPLAY_FILES = ['400.css', '600.css', '700.css'];
const MONO_FILES = ['400.css', '600.css'];

/** @type {CuratedFont[]} */
export const CURATED_FONTS = [
  {
    name: 'Newsreader',
    pkg: 'newsreader',
    category: 'serif',
    stack: '"Newsreader", Georgia, Cambria, "Times New Roman", serif',
    files: TEXT_FILES,
  },
  {
    name: 'Lora',
    pkg: 'lora',
    category: 'serif',
    stack: '"Lora", Georgia, Cambria, "Times New Roman", serif',
    files: TEXT_FILES,
  },
  {
    name: 'Cormorant Garamond',
    pkg: 'cormorant-garamond',
    category: 'serif',
    stack: '"Cormorant Garamond", Garamond, Georgia, "Times New Roman", serif',
    files: TEXT_FILES,
  },
  {
    name: 'Cinzel',
    pkg: 'cinzel',
    category: 'display',
    stack: '"Cinzel", Optima, Georgia, serif',
    files: DISPLAY_FILES,
  },
  {
    name: 'Inter',
    pkg: 'inter',
    category: 'sans',
    stack: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    files: TEXT_FILES,
  },
  {
    name: 'IBM Plex Mono',
    pkg: 'ibm-plex-mono',
    category: 'mono',
    stack: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    files: MONO_FILES,
  },
];

/** The `--font-*` custom properties a brand's `fonts` object can set. */
export const FONT_ROLES = /** @type {const} */ (['display', 'headers', 'body', 'mono']);

/**
 * Family name → lookup key. Case- and space-insensitive, so `"IBM Plex Mono"`,
 * `"ibm plex mono"` and `"IBM  Plex  Mono"` all find the same entry — an
 * operator hand-editing brand.json should not be punished for capitalisation.
 */
export function fontSlug(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

/**
 * The registry as it is emitted to dist/fonts.json and read by the server:
 * slug → { name, stack, category }. Nothing about @fontsource survives — the
 * server has no use for package names, only for the stack it writes into CSS.
 */
export function fontRegistry() {
  return Object.fromEntries(
    CURATED_FONTS.map((f) => [fontSlug(f.name), { name: f.name, stack: f.stack, category: f.category }])
  );
}

/** Markers so the block can be replaced rather than appended to. */
export const FONT_BLOCK_OPEN = '/* storylark:fonts */';
export const FONT_BLOCK_CLOSE = '/* /storylark:fonts */';

/**
 * The `:root{ --font-* }` block for a brand's font selection.
 *
 * Baked onto the end of dist/theme.css at build so a context with no injector
 * (`vite preview`, a bare static host, `vite dev`) still gets the brand's
 * fonts. On a real deployment the server replaces this block with one built
 * from the LIVE brand.json — see themeCssWithFonts/fontBlock in
 * packages/worker/src/lib/brand.ts, which produces the same shape from the same
 * registry data (emitted as dist/fonts.json) and is what makes a font swap take
 * effect without a rebuild.
 *
 * A family outside the curated set is skipped with a warning rather than
 * written out: no files ship for it, so setting the property would replace a
 * working stack with an unrenderable one.
 */
export function fontBlockCss(fonts, onWarn = (m) => console.warn(m)) {
  const registry = fontRegistry();
  const decls = [];
  for (const role of FONT_ROLES) {
    const family = fonts?.[role];
    if (!family) continue;
    const entry = registry[fontSlug(family)];
    if (!entry) {
      onWarn(
        `storylark: brand.json fonts.${role}="${family}" is not in the curated font set ` +
          `(${CURATED_FONTS.map((f) => f.name).join(', ')}) — no font files ship for it, so theme.css's own ` +
          `--font-${role} stands. Add your own @font-face to theme.css, or pick a curated family.`
      );
      continue;
    }
    decls.push(`  --font-${role}: ${entry.stack};`);
  }
  if (!decls.length) return '';
  return `${FONT_BLOCK_OPEN}\n:root {\n${decls.join('\n')}\n}\n${FONT_BLOCK_CLOSE}`;
}
