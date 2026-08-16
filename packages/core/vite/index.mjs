// storylark-core/vite — the site-facing build preset.
//
// A downstream site's whole vite.config.ts is:
//
//   import { defineStorylarkConfig } from 'storylark-core/vite';
//   export default defineStorylarkConfig();
//
// The preset owns the build mechanics (preact, PWA/service worker, virtual
// config/theme/fonts modules, manifest + icons) so a `npm update
// storylark-core` upgrades the build without touching the site's files.
//
// Brand selection: the Vite mode IS the brand id (`vite build --mode <id>`,
// matching brands/<id>/ under the site root). With no brand mode, `storylark`.
//
// Plain .mjs on purpose: Vite loads config-time code through Node, so this
// module must run without a TS compile step. Types live in ./index.d.ts.

import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync, cpSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mergeConfig } from 'vite';

const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromCore = createRequire(import.meta.url);
const BUILTIN_MODES = new Set(['development', 'production', 'test']);

/**
 * The standalone admin page (AB#7404). It is a second Vite entry owned
 * entirely by core — the site contributes no admin.html and no admin source,
 * so every deployment gets the identical portal and it can never drift per
 * site. Its HTML shell is emitted by adminPagePlugin below rather than kept
 * as a file, for the same reason.
 */
const ADMIN_ENTRY = resolve(CORE_DIR, 'src', 'admin-entry.tsx');

/**
 * @param {object} [options]
 * @param {string} [options.brandsRoot] Directory holding brand folders, relative
 *   to the site root (default `brands`).
 * @param {string} [options.brandId]    Fixed brand id (skips mode-based selection).
 * @param {import('vite').UserConfig} [options.vite] Site-level Vite overrides,
 *   merged last.
 * @returns {import('vite').UserConfigFnObject}
 */
export function defineStorylarkConfig(options = {}) {
  return ({ mode }) => {
    const siteRoot = process.cwd();
    const brandId = options.brandId ?? (mode && !BUILTIN_MODES.has(mode) ? mode : 'storylark');
    const brandDir = resolve(siteRoot, options.brandsRoot ?? 'brands', brandId);
    const brand = JSON.parse(readFileSync(resolve(brandDir, 'brand.json'), 'utf8'));
    const themeCss = readFileSync(resolve(brandDir, 'theme.css'), 'utf8');

    // A brand's appOrigin/contentOrigin in brand.json is a single fixed value,
    // but the SAME brand can be deployed to more than one platform (e.g. the
    // base "storylark" brand running on both Cloudflare and Azure for
    // dev/testing) — each deployment's content actually lives at a different
    // URL. These env vars let a platform installer override just the origins
    // at build time without needing a second brand folder. Unset = brand.json
    // wins, unchanged from before this existed.
    if (process.env.STORYLARK_APP_ORIGIN) brand.appOrigin = process.env.STORYLARK_APP_ORIGIN;
    if (process.env.STORYLARK_CONTENT_ORIGIN) brand.contentOrigin = process.env.STORYLARK_CONTENT_ORIGIN;

    /** @type {import('vite').UserConfig} */
    const config = {
      plugins: [
        preact(),
        configModulePlugin(brand),
        buildInfoPlugin(resolveBuildInfo(siteRoot, brandId)),
        fontsModulePlugin(brand),
        themePlugin(themeCss),
        brandAssetsPlugin(brandDir, brand),
        adminPagePlugin(brand, siteRoot),
        VitePWA({
          strategies: 'injectManifest',
          // The service worker ships inside storylark-core and compiles in
          // its own Vite build — hand it the core source dir plus its own
          // instance of the config plugin (plugin instances must not be shared
          // between the app and SW builds).
          srcDir: resolve(CORE_DIR, 'src'),
          filename: 'sw.ts',
          registerType: 'prompt',
          injectRegister: false,
          manifest: false, // manifest.webmanifest is emitted by brandAssetsPlugin
          injectManifest: {
            globPatterns: ['**/*.{js,css,html,woff2,svg,png,webmanifest}'],
            // The admin page is deliberately NOT part of the installable app
            // (AB#7404): readers who install the PWA must not carry operator
            // code, and the operator must never be looking at a stale cached
            // admin UI while pushing a platform update. admin.html and the
            // admin entry's own js/css are the only outputs matching these.
            globIgnores: ['**/node_modules/**/*', 'admin.html', 'assets/admin-*'],
            maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
            buildPlugins: { vite: [configModulePlugin(brand)] },
          },
        }),
      ],
      // Core ships TS/TSX source; keep it out of the dep optimizer so Vite
      // compiles it through the normal pipeline (where preact JSX applies).
      optimizeDeps: { exclude: ['storylark-core'] },
      build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: false,
        // Two entries: the reader app (the site's index.html) and the
        // standalone admin page (core's admin-entry.tsx). Separate roots,
        // separate module graphs — the reader bundle contains no admin code
        // and the admin bundle contains no reader/player/library/router code.
        // The `index` key keeps the app's chunk names unchanged from when
        // index.html was the sole implicit entry.
        rollupOptions: { input: { index: resolve(siteRoot, 'index.html'), admin: ADMIN_ENTRY } },
      },
    };
    return options.vite ? mergeConfig(config, options.vite) : config;
  };
}

/**
 * Build identity, captured once per build. The app version IS storylark-core's
 * npm version — the same number Changesets stamps on CHANGELOG.md and the one
 * RELEASE-NOTES.md headings use — so the version on screen always names an
 * actual release. The commit is the consuming site's git SHA (CI env first,
 * local git as fallback), which pins exactly which site build is deployed.
 */
function resolveBuildInfo(siteRoot, brandId) {
  const corePkg = JSON.parse(readFileSync(resolve(CORE_DIR, 'package.json'), 'utf8'));
  let commit = process.env.GITHUB_SHA ?? process.env.CF_PAGES_COMMIT_SHA ?? '';
  if (!commit) {
    try {
      commit = execSync('git rev-parse HEAD', { cwd: siteRoot, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      // not a git checkout (e.g. a tarball build) — leave blank
    }
  }
  // Companion package versions, when installed next to the site (always true in
  // the engine monorepo; thin npm sites usually only carry core — omit there).
  const requireFromSite = createRequire(resolve(siteRoot, 'package.json'));
  const versions = { 'storylark-core': corePkg.version };
  for (const pkg of ['storylark-worker', 'storylark-pipeline']) {
    try {
      versions[pkg] = JSON.parse(readFileSync(requireFromSite.resolve(`${pkg}/package.json`), 'utf8')).version;
    } catch {
      // not installed for this site — leave it out rather than guess
    }
  }
  return {
    coreVersion: corePkg.version,
    versions,
    commit: commit ? commit.slice(0, 7) : 'local',
    builtAt: new Date().toISOString(),
    brandId,
  };
}

/** Serves the build identity as `virtual:storylark-build`. */
function buildInfoPlugin(info) {
  return {
    name: 'storylark-build-module',
    resolveId(id) {
      if (id === 'virtual:storylark-build') return '\0storylark-build';
    },
    load(id) {
      if (id === '\0storylark-build') return `export default ${JSON.stringify(info)};`;
    },
  };
}

/** Serves the brand/site config as `virtual:storylark-config`. */
function configModulePlugin(brand) {
  return {
    name: 'storylark-config-module',
    resolveId(id) {
      if (id === 'virtual:storylark-config') return '\0storylark-config';
    },
    load(id) {
      if (id === '\0storylark-config') return `export default ${JSON.stringify(brand)};`;
    },
  };
}

/**
 * Serves `virtual:storylark-fonts`: @fontsource imports generated from the
 * brand's `fonts` (display/headers/body/mono family names). Families without
 * a matching @fontsource package resolve to nothing — the theme is expected
 * to provide its own @font-face (or accept the system fallback stack).
 */
function fontsModulePlugin(brand) {
  return {
    name: 'storylark-fonts-module',
    resolveId(id) {
      if (id === 'virtual:storylark-fonts') return '\0storylark-fonts';
    },
    load(id) {
      if (id !== '\0storylark-fonts') return;
      // Weights per role — reading text needs italics; UI chrome and code don't.
      const ROLE_FILES = {
        display: ['400.css', '600.css', '700.css'],
        headers: ['400.css', '600.css', '700.css'],
        body: ['400.css', '400-italic.css', '600.css', '700.css'],
        mono: ['400.css', '600.css'],
      };
      const wanted = new Map(); // @fontsource pkg -> Set of css files
      for (const [role, family] of Object.entries(brand.fonts ?? {})) {
        if (!family || !ROLE_FILES[role]) continue;
        const pkg = family.toLowerCase().replace(/\s+/g, '-');
        const files = wanted.get(pkg) ?? new Set();
        for (const f of ROLE_FILES[role]) files.add(f);
        wanted.set(pkg, files);
      }
      const imports = [];
      for (const [pkg, files] of wanted) {
        for (const file of files) {
          try {
            requireFromCore.resolve(`@fontsource/${pkg}/${file}`);
            imports.push(`import '@fontsource/${pkg}/${file}';`);
          } catch {
            // that weight/style isn't published for this family — skip
          }
        }
      }
      return imports.join('\n') || 'export {};';
    },
  };
}

/** Serves the brand's theme.css as `virtual:storylark-theme.css`. */
function themePlugin(themeCss) {
  return {
    name: 'storylark-theme',
    resolveId(id) {
      if (id === 'virtual:storylark-theme.css') return '\0storylark-theme.css';
    },
    load(id) {
      if (id === '\0storylark-theme.css') return themeCss;
    },
  };
}

/**
 * The standalone admin page's HTML shell (AB#7404).
 *
 * Note what is NOT here: no manifest link, no apple-mobile-web-app meta, no
 * service-worker registration. The admin page is outside the PWA on purpose —
 * it is never installed, never precached, and always comes from the network.
 * `noindex` keeps it out of search results; it is not a security control (the
 * portal's actual gate is the admin account behind /api/admin/*).
 */
function adminHtml(brand, scriptSrc, cssHrefs) {
  const styles = cssHrefs.map((href) => `    <link rel="stylesheet" href="${href}" />\n`).join('');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Admin — ${brand.appName}</title>
    <link rel="icon" type="image/svg+xml" href="/icons/favicon.svg" />
${styles}  </head>
  <body>
    <div id="admin" data-storylark-admin="standalone"></div>
    <script type="module" src="${scriptSrc}"></script>
  </body>
</html>
`;
}

/**
 * Emits `admin.html` at build and serves `/admin` in `vite dev`.
 *
 * The shell is generated rather than kept as a file so that a downstream site
 * owns nothing about admin: `npm update storylark-core` upgrades the portal,
 * its markup included. At build the emitted HTML points at the hashed admin
 * entry chunk and its CSS; in dev it points at core's source entry and goes
 * through Vite's own HTML transform (so the preact refresh preamble and the
 * dev client are injected exactly as they are for index.html).
 */
function adminPagePlugin(brand, siteRoot) {
  return {
    name: 'storylark-admin-page',
    configureServer(server) {
      // Outside the site root in a workspace checkout, inside node_modules in
      // an installed site — /@fs/ covers the first, a root-relative URL the
      // second (Vite only serves /@fs/ paths inside server.fs.allow).
      const rel = relative(siteRoot, ADMIN_ENTRY);
      const scriptSrc =
        rel.startsWith('..') || rel === '' ? `/@fs/${ADMIN_ENTRY.replace(/\\/g, '/')}` : `/${rel.replace(/\\/g, '/')}`;
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (path !== '/admin' && path !== '/admin/' && path !== '/admin.html') return next();
        server
          .transformIndexHtml(req.url ?? '/admin', adminHtml(brand, scriptSrc, []), req.originalUrl)
          .then((html) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
          })
          .catch(next);
      });
    },
    generateBundle(_options, bundle) {
      const chunk = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry && c.name === 'admin');
      if (!chunk) {
        this.error('storylark-admin-page: no `admin` entry chunk in the bundle — the admin page would ship without its script.');
      }
      // CSS lands on whichever chunk Rollup attributed it to — with two
      // entries sharing stylesheets that is usually a shared chunk, not the
      // admin entry itself, so walk the import graph or the page ships
      // unstyled (it did, first build).
      const css = new Set();
      const seen = new Set();
      const walk = (name) => {
        if (seen.has(name)) return;
        seen.add(name);
        const c = bundle[name];
        if (!c || c.type !== 'chunk') return;
        for (const f of c.viteMetadata?.importedCss ?? []) css.add(`/${f}`);
        for (const imported of c.imports ?? []) walk(imported);
      };
      walk(chunk.fileName);
      this.emitFile({ type: 'asset', fileName: 'admin.html', source: adminHtml(brand, `/${chunk.fileName}`, [...css]) });
    },
  };
}

/** Brand-titles index.html and emits manifest.webmanifest + brand icons. */
function brandAssetsPlugin(brandDir, brand) {
  let outDir = 'dist';
  let root = process.cwd();
  return {
    name: 'storylark-brand-assets',
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    transformIndexHtml(html, ctx) {
      // The standalone admin page titles itself ("Admin — <appName>") and is
      // served by adminPagePlugin, not from a site file — leave it alone.
      if (ctx?.path?.startsWith('/admin')) return html;
      // Brand-driven document title: follows whatever theme builds.
      return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${brand.appName}</title>`);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(
          {
            name: `${brand.appName}: ${brand.name}`,
            short_name: brand.shortName ?? brand.appName,
            description: brand.tagline,
            id: '/',
            start_url: '/',
            scope: '/',
            display: 'standalone',
            theme_color: brand.themeColor,
            background_color: brand.backgroundColor,
            icons: [
              { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
              { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
              { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            ],
          },
          null,
          2
        ),
      });
    },
    closeBundle() {
      const icons = resolve(brandDir, 'assets', 'icons');
      if (existsSync(icons)) {
        cpSync(icons, resolve(root, outDir, 'icons'), { recursive: true });
      }
    },
  };
}
