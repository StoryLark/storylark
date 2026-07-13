import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync, cpSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// The build "mode" IS the brand id: `vite build --mode <brandId>`. With no
// brand-specific mode (plain `vite build`/`vite dev`), the default is the
// `storylark` base theme.
const BUILTIN_MODES = new Set(['development', 'production', 'test']);
export default defineConfig(({ mode }) => {
  const brandId = mode && !BUILTIN_MODES.has(mode) ? mode : 'storylark';
  const brandDir = resolve(HERE, '..', 'brands', brandId);
  const brand = JSON.parse(readFileSync(resolve(brandDir, 'brand.json'), 'utf8'));
  const themeCss = readFileSync(resolve(brandDir, 'theme.css'), 'utf8');

  return {
    plugins: [
      preact(),
      brandPlugin(brandId, brandDir, brand, themeCss),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: false,
        manifest: false, // we emit our own manifest.webmanifest in brandPlugin
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,woff2,svg,png,webmanifest}'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
      }),
    ],
    define: {
      __BRAND__: JSON.stringify(brand),
    },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  };
});

/** Emits theme.css, manifest.webmanifest and brand icons into the bundle. */
function brandPlugin(brandId: string, brandDir: string, brand: Record<string, unknown>, themeCss: string): Plugin {
  return {
    name: 'storylark-brand',
    transformIndexHtml(html) {
      // Brand-driven document title: follows whatever theme builds.
      return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${brand.appName}</title>`);
    },
    resolveId(id) {
      if (id === 'virtual:brand-theme.css') return '\0brand-theme.css';
    },
    load(id) {
      if (id === '\0brand-theme.css') return themeCss;
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
        cpSync(icons, resolve(HERE, 'dist', 'icons'), { recursive: true });
      }
    },
  };
}
