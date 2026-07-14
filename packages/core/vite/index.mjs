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
