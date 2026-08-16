// storylark-core/vite — the site-facing build preset.
//
// A downstream site's whole vite.config.ts is:
//
//   import { defineStorylarkConfig } from 'storylark-core/vite';
//   export default defineStorylarkConfig();
//
// The preset owns the build mechanics (preact, PWA/service worker, virtual
// config/fonts modules, brand + theme + manifest + icon outputs) so a `npm
// update storylark-core` upgrades the build without touching the site's files.
//
// Brand selection: the Vite mode IS the brand id (`vite build --mode <id>`,
// matching brands/<id>/ under the site root). With no brand mode, `storylark`.
//
// One mode is reserved: `--mode engine` builds the BRAND-FREE engine — see
// ENGINE_MODE below (AB#7418 — plan §0d Phase 5).
//
// Plain .mjs on purpose: Vite loads config-time code through Node, so this
// module must run without a TS compile step. Types live in ./index.d.ts.

import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync, readdirSync, writeFileSync, cpSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mergeConfig } from 'vite';
import {
  BRAND_SCHEMA,
  PRESENTATION_SCHEMA,
  DEPLOYMENT_SCHEMA,
  DEPLOYMENT_DEFAULTS,
  readContract,
} from '../schemas/validate.mjs';
import { CURATED_FONTS, fontBlockCss, fontRegistry } from './fonts.mjs';

const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromCore = createRequire(import.meta.url);

/**
 * The reserved mode that builds the ENGINE rather than a site (AB#7418 —
 * plan §0d Phase 5).
 *
 * ── Why it has to exist ─────────────────────────────────────────────────────
 * Phase 5 wants ONE prebuilt bundle that is correct for every deployment, so an
 * update can be "download it, keep your brand, restart" instead of "rebuild on
 * your own machine". Phases 1-3 made brand, presentation and deployment config
 * runtime DATA — but they deliberately kept a build-time FALLBACK compiled in
 * (`virtual:storylark-config` / `-presentation` / `-deployment`) for contexts
 * with no injector: `vite dev`, `vite preview`, a bare static host, or a
 * platform mid-update still running an older engine. That fallback is real
 * brand data inside the JS chunk, and it is why two brands' builds are NOT
 * byte-identical. Measured, not assumed: `storylark` vs `nebula` on 0.14.0
 * agree on 212 of 232 files and differ on exactly the six that carry brand —
 * index.html, admin.html, sw.js and the three entry chunks — plus the
 * brand-owned files themselves (brand.json, presentation.json, theme.css,
 * manifest.webmanifest, icons/*).
 *
 * `--mode engine` resolves all three contracts to EMPTY. The fallback is then
 * "core's own defaults", which is the right answer for a bundle that has no
 * brand yet, and the output carries no customer data at all — the same bytes
 * for every deployment on a given engine version.
 *
 * ── What it does NOT emit, and why that is the point ────────────────────────
 * No brand.json, no presentation.json, no theme.css, no manifest.webmanifest,
 * no icons/. Those are the deployment's OWN files; an update preserves them
 * rather than shipping someone else's. A dist/ from this mode is therefore not
 * a runnable site on its own — it is half of one, and the deployment supplies
 * the other half.
 *
 * ── Safe only because injection is unconditional ────────────────────────────
 * Both platform entries inject the deployment config into every document with
 * no "if configured" test, and inject brand/presentation whenever the files are
 * present — which they are, because the update preserves them. So the neutral
 * fallback is never what a reader sees. `vite preview` of an engine build IS
 * unbranded, and that is honest rather than broken.
 */
export const ENGINE_MODE = 'engine';

const BUILTIN_MODES = new Set(['development', 'production', 'test']);

/**
 * Files a build emits that belong to the DEPLOYMENT, not to the engine.
 *
 * The one list, exported so the release packager and the in-portal updater
 * agree about what an update must leave alone. `icons/` is a prefix: the icon
 * set is copied wholesale from brands/<id>/assets/icons/, so its member names
 * are a brand's business and cannot be enumerated here.
 */
export const BRAND_OWNED_OUTPUTS = ['brand.json', 'presentation.json', 'theme.css', 'manifest.webmanifest'];
export const BRAND_OWNED_PREFIXES = ['icons/'];

/** True for a path (relative to dist/, forward slashes) the deployment owns. */
export function isBrandOwnedOutput(path) {
  return BRAND_OWNED_OUTPUTS.includes(path) || BRAND_OWNED_PREFIXES.some((p) => path.startsWith(p));
}

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
 * @param {string} [options.presentationRoot] Directory holding presentation
 *   folders, relative to the site root (default: `presentation` beside `brandsRoot`).
 * @param {string} [options.deploymentRoot] Directory holding deployment-config
 *   folders, relative to the site root (default: `deployment` beside `brandsRoot`).
 * @param {string} [options.brandId]    Fixed brand id (skips mode-based selection).
 * @param {import('vite').UserConfig} [options.vite] Site-level Vite overrides,
 *   merged last.
 * @returns {import('vite').UserConfigFnObject}
 */
export function defineStorylarkConfig(options = {}) {
  return ({ mode }) => {
    const siteRoot = process.cwd();
    const engineBuild = options.brandId === ENGINE_MODE || mode === ENGINE_MODE;
    const brandId = engineBuild ? ENGINE_MODE : options.brandId ?? (mode && !BUILTIN_MODES.has(mode) ? mode : 'storylark');
    const brandDir = resolve(siteRoot, options.brandsRoot ?? 'brands', brandId);
    const { brand, identity, presentation, deployment } = engineBuild
      ? neutralConfig()
      : loadStorylarkConfig(siteRoot, brandId, brandDir, options);
    const themeFile = resolve(brandDir, 'theme.css');

    /** @type {import('vite').UserConfig} */
    const config = {
      plugins: [
        preact(),
        configModulePlugin(brand),
        presentationModulePlugin(presentation),
        // The three brand-owned outputs are skipped in an engine build: an
        // update preserves the deployment's own copies rather than shipping a
        // neutral one on top of them.
        ...(engineBuild ? [] : [presentationAssetPlugin(presentation), themePlugin(themeFile, identity), brandAssetsPlugin(brandDir, identity)]),
        ...(engineBuild ? [engineDocumentPlugin()] : []),
        deploymentModulePlugin(deployment),
        buildInfoPlugin(resolveBuildInfo(siteRoot, brandId)),
        fontsModulePlugin(),
        adminPagePlugin(brand, siteRoot),
        outputManifestPlugin(),
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
            // What is NOT precached is the interesting part (AB#7415):
            //
            //   *.woff2 — the curated set ships every family so a brand can
            //     switch fonts without a rebuild; precaching all of them would
            //     make every reader download six typefaces to use one. sw.ts
            //     caches a font the first time something renders in it.
            //   *.webmanifest — generated per request from the live brand, so a
            //     precached copy would name the app after whichever brand was
            //     current at the last build.
            //   theme.css / brand.json / presentation.json — the files an
            //     operator swaps. A precache entry is keyed to the BUILD, so
            //     precaching them is exactly the "service worker serves a stale
            //     brand" failure the plan warns about. theme.css is
            //     network-first in sw.ts; brand.json and presentation.json are
            //     never fetched by the client at all (they arrive injected, and
            //     the worker re-stamps the cached shell with both).
            //   icons/** — swappable since Phase 4 (an imported theme's icons
            //     come out of storage) and absent entirely from a Phase 5 engine
            //     build, which ships no brand files at all. Precaching them
            //     would pin an installed PWA to the pictures it was installed
            //     with AND would make the precache manifest differ between an
            //     engine build and a brand build. sw.ts caches them
            //     stale-while-revalidate instead: same offline floor, no pin.
            globPatterns: ['**/*.{js,css,html,svg,png}'],
            // The admin page is deliberately NOT part of the installable app
            // (AB#7404): readers who install the PWA must not carry operator
            // code, and the operator must never be looking at a stale cached
            // admin UI while pushing a platform update. admin.html and the
            // admin entry's own js/css are the only outputs matching these.
            globIgnores: ['**/node_modules/**/*', 'admin.html', 'assets/admin-*', 'theme.css', 'icons/**'],
            maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
            buildPlugins: {
              vite: [configModulePlugin(brand), presentationModulePlugin(presentation), deploymentModulePlugin(deployment)],
            },
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
 * Loads the three contracts a build needs and resolves them into the three
 * objects the app sees:
 *
 *   virtual:storylark-config        brand identity + look (Brand)
 *   virtual:storylark-presentation  layout, nouns and the §0b keys, AS STATED
 *   virtual:storylark-deployment    origins, VAPID public key, tts
 *
 * from:
 *
 *   brands/<id>/brand.json                identity + look   — portable
 *   presentation/<id>/presentation.json   shape             — portable
 *   deployment/<id>/deployment.json       origins/keys/tts  — never portable
 *
 * They used to be one file, which is why an Azure deployment once served the
 * wrong content origin: `contentOrigin` was baked into the brand every install
 * of that brand shared. Splitting them is what makes "a core update never
 * touches your brand" and "the same brand runs on two platforms" both true.
 *
 * Resolution order, per contract:
 *   presentation — NOT resolved here at all (AB#7416). The file travels as it
 *                  was written, unknown keys dropped, and the FRONTEND fills in
 *                  every absent key from DEFAULT_PRESENTATION. Resolving here
 *                  as well would freeze today's defaults into a customer's
 *                  bundle, so a later core update with a better default could
 *                  never reach them — "a missing key takes the core default,
 *                  PERMANENTLY" means core's current default, not the one that
 *                  happened to be current the day they last built.
 *   deployment   — env var (STORYLARK_*), else file value, else core default.
 *                  Env wins because that is how an installer configures a
 *                  deployment it just provisioned.
 *
 * None of this is the source of truth on a real deployment any more. The
 * platform serving the app injects the live deployment config (AB#7414 —
 * packages/worker/src/lib/deployment.ts, from environment variables), the live
 * brand IDENTITY (AB#7415 — .../lib/brand.ts, from dist/brand.json) and the live
 * PRESENTATION (AB#7416 — .../lib/presentation.ts, from dist/presentation.json)
 * into every document at response time; what is compiled in here is the fallback
 * for a context with no injection — `vite dev`, `vite preview`, a plain static
 * host, or a platform mid-update still running an older engine.
 */
function loadStorylarkConfig(siteRoot, brandId, brandDir, options = {}) {
  const brandFile = resolve(brandDir, 'brand.json');
  // presentation/ and deployment/ sit beside brands/, wherever brands/ is — a
  // site that points brandsRoot elsewhere (this repo's app/ uses '../brands')
  // gets the other two from the same place without configuring it twice.
  const beside = resolve(brandDir, '..', '..');
  const presentationFile = options.presentationRoot
    ? resolve(siteRoot, options.presentationRoot, brandId, 'presentation.json')
    : resolve(beside, 'presentation', brandId, 'presentation.json');
  const deploymentFile = options.deploymentRoot
    ? resolve(siteRoot, options.deploymentRoot, brandId, 'deployment.json')
    : resolve(beside, 'deployment', brandId, 'deployment.json');

  const raw = JSON.parse(readFileSync(brandFile, 'utf8'));

  // Legacy: a pre-split brand.json (no contractVersion) still builds. A core
  // update must never break a customer's existing brand — that is the whole
  // point of this split — so we split it in memory and tell them to migrate,
  // rather than failing their build on a file that worked yesterday.
  if (raw.contractVersion === undefined) {
    console.warn(
      `\n  storylark: ${relative(siteRoot, brandFile) || brandFile} is a pre-split brand file.\n` +
        '  It still builds, unchanged, but identity/presentation/deployment are now separate\n' +
        '  contracts. Run `npm run migrate-brand` to split it (it backs up the original).\n'
    );
    const { layout, nouns, appOrigin, contentOrigin, vapidPublicKey, tts, ...identity } = raw;
    return {
      brand: resolveConfig(identity),
      identity: resolveIdentity(identity),
      presentation: resolvePresentation({ contractVersion: 1, layout, nouns }),
      deployment: deploymentFromEnv({ appOrigin, contentOrigin, vapidPublicKey, tts }),
    };
  }

  const identity = readContract(brandFile, BRAND_SCHEMA, { label: relative(siteRoot, brandFile) || brandFile });
  const presentation = existsSync(presentationFile)
    ? readContract(presentationFile, PRESENTATION_SCHEMA, { label: relative(siteRoot, presentationFile) })
    : {};
  const deployment = existsSync(deploymentFile)
    ? readContract(deploymentFile, DEPLOYMENT_SCHEMA, { label: relative(siteRoot, deploymentFile) })
    : {};

  return {
    brand: resolveConfig(identity),
    identity: resolveIdentity(identity),
    presentation: resolvePresentation(presentation),
    deployment: deploymentFromEnv(deployment),
  };
}

/**
 * The three contracts, all empty — what `--mode engine` builds against
 * (AB#7418 — plan §0d Phase 5).
 *
 * Deliberately not "the defaults": `{}` for each. A default written into the
 * bundle is a value a later core release could never improve for that
 * deployment, which is the exact reasoning resolvePresentation already follows
 * ("resolving here would freeze today's defaults into a customer's bundle").
 * An engine bundle is the extreme case of that — it is meant to be dropped onto
 * deployments that have not been rebuilt for years — so it states nothing and
 * lets the frontend resolver and the serving platform between them decide
 * everything.
 *
 * Deployment config is the one place that is NOT quite empty: DEPLOYMENT_DEFAULTS
 * is core's own contract default, not a brand's data, and dropping it would put
 * `undefined` where the frontend expects a string in the one context nothing
 * injects into. Crucially, the STORYLARK_* env overrides are NOT applied — an
 * engine artifact must never carry the origins of the machine that built it.
 */
function neutralConfig() {
  const deployment = { ...DEPLOYMENT_DEFAULTS };
  delete deployment.contractVersion;
  return { brand: {}, identity: { contractVersion: 1 }, presentation: {}, deployment };
}

/**
 * The identity half on its own — what gets written to dist/brand.json
 * (AB#7415 — plan §0d Phase 2).
 *
 * Deliberately NOT the same object as `brand`: this one carries identity only,
 * with `layout`/`nouns` excluded by construction rather than by convention. It
 * is the file an operator swaps on a deployed site, and the file the serving
 * platform re-reads on every request, so anything that leaked in here would
 * quietly become runtime-swappable before the phase that is supposed to make it
 * so. `contractVersion` is kept — the file stays a valid brand.json, which is
 * what makes "download it, edit it, upload it" a coherent operation.
 */
function resolveIdentity(identity) {
  const keys = [
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
  ];
  const out = stripUndefined(Object.fromEntries(keys.map((k) => [k, identity[k]])));
  if (out.contractVersion === undefined) out.contractVersion = 1; // a pre-split brand becomes a current one on the way out
  return out;
}

/**
 * The build-time deployment fallback: env override, else the file, else the
 * core default.
 *
 * These STORYLARK_* overrides are deliberately KEPT now that serve-time
 * injection exists (AB#7414). They are not a competing mechanism — they set
 * the value a build carries for contexts nothing injects into, and that is
 * still load-bearing in three places: both platform installers use them to
 * point a freshly provisioned site's build at itself, `vite preview` and plain
 * static hosting have no server to inject, and a document served by a platform
 * mid-update may come from an older engine that does not inject yet. Removing
 * them would break all three to delete six lines.
 *
 * The layering to keep in mind: env-at-BUILD > file > core default, and then
 * env-at-SERVE beats the whole stack at request time.
 */
function deploymentFromEnv(deployment) {
  const env = process.env;
  const out = { ...DEPLOYMENT_DEFAULTS, ...stripUndefined(deployment) };
  delete out.contractVersion;
  if (env.STORYLARK_APP_ORIGIN) out.appOrigin = env.STORYLARK_APP_ORIGIN;
  if (env.STORYLARK_CONTENT_ORIGIN) out.contentOrigin = env.STORYLARK_CONTENT_ORIGIN;
  if (env.STORYLARK_VAPID_PUBLIC_KEY) out.vapidPublicKey = env.STORYLARK_VAPID_PUBLIC_KEY;

  const tts = { ...out.tts };
  if (env.STORYLARK_TTS_VOICE) tts.voice = env.STORYLARK_TTS_VOICE;
  if (env.STORYLARK_TTS_RATE) tts.rate = env.STORYLARK_TTS_RATE;
  if (env.STORYLARK_TTS_OUTPUT_FORMAT) tts.outputFormat = env.STORYLARK_TTS_OUTPUT_FORMAT;
  if (env.STORYLARK_TTS_VOICES) {
    tts.voices = env.STORYLARK_TTS_VOICES.split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (Object.keys(tts).length) out.tts = tts;
  return out;
}

/**
 * The `Brand` object the app compiles against — identity and look, nothing else.
 *
 * Deployment config is not in it (AB#7414) and presentation is not in it any
 * more either (AB#7416): all three have different lifetimes. The brand is who
 * the site is; presentation is how it is arranged and is swapped by the
 * operator; origins and keys belong to whichever deployment happens to be
 * serving the bundle right now. Keeping them in one object is what let one
 * deployment's URLs travel inside a brand in the first place.
 */
function resolveConfig(identity) {
  return stripUndefined({
    id: identity.id,
    name: identity.name,
    appName: identity.appName,
    shortName: identity.shortName,
    tagline: identity.tagline,
    themeColor: identity.themeColor,
    backgroundColor: identity.backgroundColor,
    defaultTheme: identity.defaultTheme,
    author: identity.author,
    fonts: identity.fonts,
  });
}

/**
 * The presentation as STATED, with unknown keys removed — the thing that both
 * becomes `virtual:storylark-presentation` and is written to
 * dist/presentation.json (AB#7416).
 *
 * Note what does NOT happen here: no defaults are applied. This is the file, as
 * the operator wrote it, minus anything this engine does not recognise. Rule 2
 * for real — an unknown key is *ignored*, not merely warned about, so it never
 * reaches the bundle and can never be depended on by accident — and rule 1 left
 * to the frontend, which is the only place that knows what an absent key means.
 *
 * `contractVersion` is kept, so the emitted file stays a valid presentation.json
 * and "download it, edit it, upload it" is a coherent operation.
 */
function resolvePresentation(presentation) {
  const known = Object.keys(PRESENTATION_SCHEMA.properties ?? {});
  return stripUndefined(Object.fromEntries(known.map((k) => [k, (presentation ?? {})[k]])));
}

/** Drops undefined values so they never reach the bundle as explicit keys. */
function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined));
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
    // STORYLARK_BUILD_TIME makes a build REPRODUCIBLE (AB#7418). Without it the
    // timestamp is the one thing that changes between two otherwise identical
    // builds — which was already noted in Phase 0 ("the three that differ do so
    // only because the bundle carries a build timestamp") and which would make
    // "is this prebuilt engine artifact free of brand data?" unanswerable by
    // comparison. CI sets it once per release; nothing else needs to.
    builtAt: process.env.STORYLARK_BUILD_TIME || new Date().toISOString(),
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
 * Serves the build-time presentation fallback as `virtual:storylark-presentation`
 * (AB#7416 — plan §0d Phase 3).
 *
 * This is the FALLBACK only — the live presentation comes from
 * dist/presentation.json, injected by the serving platform (see
 * presentationAssetPlugin below and packages/worker/src/lib/presentation.ts).
 * It exists so the app still works where nothing injects: `vite dev`, `vite
 * preview`, a plain static host, or a platform mid-update on an older engine.
 *
 * Instantiated twice — once for the app build, once for the service-worker
 * build (see `buildPlugins` in defineStorylarkConfig) — because sw.ts re-stamps
 * the precached shell and therefore imports src/presentation.ts too. Plugin
 * instances must not be shared between the two builds.
 */
function presentationModulePlugin(presentation) {
  return {
    name: 'storylark-presentation-module',
    resolveId(id) {
      if (id === 'virtual:storylark-presentation') return '\0storylark-presentation';
    },
    load(id) {
      if (id === '\0storylark-presentation') return `export default ${JSON.stringify(presentation)};`;
    },
  };
}

/**
 * Emits `dist/presentation.json` — the file an operator swaps (AB#7416).
 *
 * Separate from presentationModulePlugin above, and only in the app build, for
 * a mechanical reason: that one is instantiated a second time for the
 * service-worker build, which writes into the same output directory, and two
 * plugins emitting the same fileName is a build error rather than a harmless
 * duplicate.
 *
 * The emitted file is the presentation AS STATED, not a resolved one — see
 * resolvePresentation above for why writing today's defaults into a customer's
 * deployment would break the compatibility promise rather than help it. It also
 * keeps the file small and hand-editable, which is the point of it being the
 * file an operator downloads, edits and uploads.
 *
 * In `vite dev` there is no dist/, so the middleware serves the same bytes from
 * memory: /presentation.json is a real URL in every context.
 */
function presentationAssetPlugin(presentation) {
  const body = `${JSON.stringify(presentation, null, 2)}\n`;
  return {
    name: 'storylark-presentation-asset',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/presentation.json') return next();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'presentation.json', source: body });
    },
  };
}

/**
 * Serves the build-time deployment fallback as `virtual:storylark-deployment`
 * (AB#7414).
 *
 * A separate module from the brand on purpose, and not just for tidiness: it
 * is the only part of the compiled config the running deployment is allowed to
 * override, so the seam has to be visible in the code. src/deployment.ts reads
 * this and lets the injected `self.__STORYLARK_DEPLOYMENT__` win key by key.
 */
function deploymentModulePlugin(deployment) {
  return {
    name: 'storylark-deployment-module',
    resolveId(id) {
      if (id === 'virtual:storylark-deployment') return '\0storylark-deployment';
    },
    load(id) {
      if (id === '\0storylark-deployment') return `export default ${JSON.stringify(deployment)};`;
    },
  };
}

/**
 * Serves `virtual:storylark-fonts`: the @fontsource imports for the WHOLE
 * curated set, and emits the registry as dist/fonts.json (AB#7415).
 *
 * It used to import only the families the brand named. That cannot survive
 * Phase 2: the brand's font choice is now a runtime value, so a deployment can
 * change it between two requests, and a family whose @font-face never shipped
 * renders as the browser default however correctly it was selected. Shipping
 * the set once — the same files for every brand — is what makes the selection
 * swappable at all.
 *
 * What this costs is @font-face CSS for six families instead of two (a few KB
 * gzipped) in the bundle. What it does NOT cost is the typefaces themselves: a
 * browser downloads a font file only when something on the page renders in it,
 * so an unused family in the set is declarations, not bytes over the wire. See
 * also the precache note in defineStorylarkConfig — they are not precached
 * either, for the same reason.
 */
function fontsModulePlugin() {
  return {
    name: 'storylark-fonts-module',
    resolveId(id) {
      if (id === 'virtual:storylark-fonts') return '\0storylark-fonts';
    },
    load(id) {
      if (id !== '\0storylark-fonts') return;
      const imports = [];
      for (const font of CURATED_FONTS) {
        for (const file of font.files) {
          try {
            requireFromCore.resolve(`@fontsource/${font.pkg}/${file}`);
            imports.push(`import '@fontsource/${font.pkg}/${file}';`);
          } catch {
            // that weight/style isn't published for this family — skip
          }
        }
      }
      return imports.join('\n') || 'export {};';
    },
    generateBundle() {
      // The registry, as a build output rather than as something the server
      // package duplicates. storylark-worker reads this to turn the live
      // brand's font names into --font-* declarations; emitting it here means
      // the stacks the server serves always match the files this build shipped.
      this.emitFile({
        type: 'asset',
        fileName: 'fonts.json',
        source: JSON.stringify({ families: fontRegistry() }, null, 2),
      });
    },
  };
}

/**
 * The brand's theme.css, as a real static file (AB#7415 — plan §0d Phase 2).
 *
 * It used to be `virtual:storylark-theme.css`, imported by mount.tsx and
 * therefore compiled into a content-hashed CSS chunk — which meant retuning a
 * colour required rebuilding the engine. Now it is emitted as `dist/theme.css`
 * and linked from the document, so replacing that one file on a deployed site
 * restyles it with no rebuild, and the platform can append the live brand's
 * font selection to it on the way out (see themeCssWithFonts in
 * packages/worker/src/lib/brand.ts).
 *
 * The build bakes the brand's own font block onto the end, so `vite preview`, a
 * bare static host and `vite dev` — none of which have an injector — still get
 * the brand's fonts. The server replaces that block rather than appending a
 * second one; the markers are what make that possible.
 */
function themePlugin(themeFile, identity) {
  const compose = () => {
    const css = readFileSync(themeFile, 'utf8').trimEnd();
    const block = fontBlockCss(identity.fonts);
    return block ? `${css}\n${block}\n` : `${css}\n`;
  };
  return {
    name: 'storylark-theme',
    configureServer(server) {
      // `vite dev` has no dist/. Serve the same composed stylesheet straight
      // from the brand folder, and watch it, so editing theme.css is still a
      // save-and-see loop rather than a restart.
      server.watcher.add(themeFile);
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/theme.css') return next();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(compose());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'theme.css', source: compose() });
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
    <title data-storylark-title="admin">Admin — ${brand.appName ?? NEUTRAL_APP_NAME}</title>
    <link rel="icon" type="image/svg+xml" href="/icons/favicon.svg" />
    <link rel="stylesheet" href="/theme.css" />
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

/**
 * Emits the brand's runtime assets and wires the document to them.
 *
 *   dist/brand.json           the live identity, re-read by the server on every
 *                             request — the file an operator swaps (AB#7415)
 *   dist/manifest.webmanifest the static fallback; a real deployment generates
 *                             this per request from brand.json instead
 *   dist/icons/               the icon FILES, still build-time (see below)
 *
 * and, in index.html: `<link rel="stylesheet" href="/theme.css">` plus the
 * `data-storylark-title` marker the server needs to retitle the page without
 * knowing which page it is.
 *
 * Icons stay a build concern on purpose. A manifest is JSON and can be
 * generated from current data at zero cost; an icon is a picture, and swapping
 * one means putting different bytes at /icons/icon-192.png — which needs no
 * code, only a file. Generating icons from brand data (rasterising a colour and
 * a letter, say) would be inventing a feature nobody asked for; importing them
 * as part of a brand package is Phase 4's job.
 */
function brandAssetsPlugin(brandDir, identity) {
  let outDir = 'dist';
  let root = process.cwd();
  return {
    name: 'storylark-brand-assets',
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    transformIndexHtml: { order: 'pre', handler: (html, ctx) => stampDocument(html, ctx, identity.appName) },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'brand.json', source: `${JSON.stringify(identity, null, 2)}\n` });
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(
          {
            name: `${identity.appName}: ${identity.name}`,
            short_name: identity.shortName ?? identity.appName,
            description: identity.tagline,
            id: '/',
            start_url: '/',
            scope: '/',
            display: 'standalone',
            theme_color: identity.themeColor,
            background_color: identity.backgroundColor,
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

/**
 * The engine-owned parts of index.html: the title MARKER and the /theme.css
 * link. Shared by the brand build and the engine build (AB#7418) because they
 * are structure, not identity — the serving platform rewrites the title from
 * the live brand before any JavaScript runs, and it can only find it if the
 * marker is there. An engine build therefore emits the same document shape with
 * a neutral title inside the marker.
 *
 * The theme link goes in by hand rather than through `tags`, because
 * `injectTo: 'head-prepend'` would put a stylesheet ahead of `<meta charset>`.
 * It has to come BEFORE the app's own stylesheets — where it sat when it was an
 * import at the top of mount.tsx — and Vite appends those at the end of <head>,
 * so anywhere near the top works. Immediately after the charset declaration is
 * both.
 */
function stampDocument(html, ctx, appName) {
  // The standalone admin page titles itself ("Admin — <appName>") and is served
  // by adminPagePlugin, not from a site file — leave it alone.
  if (ctx?.path?.startsWith('/admin')) return html;
  const titled = html.replace(/<title>[\s\S]*?<\/title>/, `<title data-storylark-title="app">${appName ?? NEUTRAL_APP_NAME}</title>`);
  const link = '\n    <link rel="stylesheet" href="/theme.css" />';
  const charset = /<meta charset=[^>]*>/i.exec(titled);
  if (charset) return titled.slice(0, charset.index + charset[0].length) + link + titled.slice(charset.index + charset[0].length);
  const head = /<head[^>]*>/i.exec(titled);
  if (head) return titled.slice(0, head.index + head[0].length) + link + titled.slice(head.index + head[0].length);
  return titled;
}

/**
 * What an engine build calls itself where a brand build would say a name
 * (AB#7418). It reaches a reader only on a site that ships no brand.json at
 * all, which on a real deployment cannot happen — an update preserves that
 * file, and a fresh install builds a brand. It is the product's own name rather
 * than a placeholder because "StoryLark" is also core's own default for the
 * same field (packages/core/src/brand.ts), so the two agree.
 */
const NEUTRAL_APP_NAME = 'StoryLark';

/**
 * The engine build's substitute for brandAssetsPlugin + themePlugin (AB#7418).
 *
 * Emits nothing. Its whole job is the document stamp above, so index.html comes
 * out of an engine build byte-identical in STRUCTURE to a brand build's — same
 * title marker, same /theme.css link — while carrying no brand.
 */
function engineDocumentPlugin() {
  return {
    name: 'storylark-engine-document',
    transformIndexHtml: { order: 'pre', handler: (html, ctx) => stampDocument(html, ctx, NEUTRAL_APP_NAME) },
  };
}

/**
 * Emits `dist/outputs.json` — every file this build produced, with its sha256
 * (AB#7418 — plan §0d Phase 5).
 *
 * Two callers need it and neither can get the list any other way:
 *
 *  1. The release packager (.github/workflows/release.yml) uses it to prove the
 *     artifact it uploads is the artifact this build produced.
 *  2. The in-portal updater on Cloudflare NEEDS to enumerate the deployment's
 *     current assets and cannot. `env.ASSETS` can fetch a known path but has no
 *     list API, and Cloudflare's asset upload takes a manifest of the COMPLETE
 *     asset set — so without this file the updater could not carry the
 *     deployment's own icons across an update, because icon names come from
 *     brands/<id>/assets/icons/ and are a brand's business, not a fixed list.
 *
 * Written in closeBundle rather than generateBundle so it sees the icons
 * brandAssetsPlugin copies in ITS closeBundle. It therefore cannot list itself,
 * which is stated in the file so nobody reads the omission as a bug.
 */
function outputManifestPlugin() {
  let outDir = 'dist';
  let root = process.cwd();
  return {
    name: 'storylark-output-manifest',
    // Last, so every other plugin's closeBundle has already written its files.
    enforce: 'post',
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    closeBundle() {
      const dist = resolve(root, outDir);
      if (!existsSync(dist)) return;
      const files = {};
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          const rel = relative(dist, full).split(sep).join('/');
          if (rel === OUTPUT_MANIFEST) continue;
          const body = readFileSync(full);
          files[rel] = { sha256: createHash('sha256').update(body).digest('hex'), size: statSync(full).size };
        }
      };
      walk(dist);
      const doc = {
        formatVersion: 1,
        note: 'Every file this build wrote, except this one. `brandOwned` marks the files that belong to the deployment rather than to the engine; an engine update replaces the others and leaves these alone.',
        files: Object.fromEntries(
          Object.entries(files).map(([path, meta]) => [path, isBrandOwnedOutput(path) ? { ...meta, brandOwned: true } : meta])
        ),
      };
      writeFileSync(resolve(dist, OUTPUT_MANIFEST), `${JSON.stringify(doc, null, 2)}\n`);
    },
  };
}

/** Where outputManifestPlugin writes, relative to dist/. */
export const OUTPUT_MANIFEST = 'outputs.json';
