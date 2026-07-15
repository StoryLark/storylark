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
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mergeConfig } from 'vite';

const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromCore = createRequire(import.meta.url);
const BUILTIN_MODES = new Set(['development', 'production', 'test']);

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

    /** @type {import('vite').UserConfig} */
    const config = {
      plugins: [
        preact(),
        configModulePlugin(brand),
        buildInfoPlugin(resolveBuildInfo(siteRoot, brandId)),
        fontsModulePlugin(brand),
        themePlugin(themeCss),
        brandAssetsPlugin(brandDir, brand),
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
            maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
            buildPlugins: { vite: [configModulePlugin(brand)] },
          },
        }),
      ],
      // Core ships TS/TSX source; keep it out of the dep optimizer so Vite
      // compiles it through the normal pipeline (where preact JSX applies).
      optimizeDeps: { exclude: ['storylark-core'] },
      build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
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
    transformIndexHtml(html) {
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
