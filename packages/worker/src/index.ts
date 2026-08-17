import { Hono } from 'hono';
import type { AppContext, Env } from './types';
import { d1Database } from './db/d1';
import { auth } from './routes/auth';
import { passkeys } from './routes/passkeys';
import { progress } from './routes/progress';
import { preferences } from './routes/preferences';
import { bookmarks } from './routes/bookmarks';
import { push } from './routes/push';
import { admin } from './routes/admin';
import { adminAuth } from './routes/admin-auth';
import { adminContent } from './routes/admin-content';
import { adminNarration } from './routes/admin-narration';
import { adminSync } from './routes/admin-sync';
import { adminThemes } from './routes/admin-themes';
import { contentApi } from './routes/content-api';
import { scheduledContentSync } from './lib/repo-sync';
import { IMMUTABLE, SHORT, r2ContentStore } from './lib/content-store';
import { readActiveTheme, readActiveCss, readActiveIcon, type ActiveTheme } from './lib/theme-store';
import { readActiveEngineCached, readEngineFile, findEngineAsset, type ActiveEngine } from './lib/engine-store';
import { checkForUpdateAndNotify } from './lib/update-check';
import { cloudflareSelfDeploy } from './lib/self-deploy';
import { deploymentConfigFromEnv, injectDeploymentIntoHtml, injectDeploymentIntoScript } from './lib/deployment';
import {
  BRAND_ASSET,
  FONTS_ASSET,
  THEME_ASSET,
  injectBrandIntoHtml,
  injectBrandIntoScript,
  manifestFromBrand,
  readBrandAsset,
  readFontRegistry,
  themeCssWithFonts,
  type BrandIdentity,
  type FontRegistry,
} from './lib/brand';
import {
  PRESENTATION_ASSET,
  injectPresentationIntoHtml,
  injectPresentationIntoScript,
  readPresentationAsset,
  type PresentationInput,
} from './lib/presentation';

const app = new Hono<AppContext>();

app.get('/api/health', (c) => c.json({ ok: true, brand: c.env.BRAND }));

app.get('/api/library/version', async (c) => {
  const row = await c.env.DB.prepare('SELECT manifest_version, updated_at FROM library_state WHERE id = 1').first<{
    manifest_version: number;
    updated_at: number;
  }>();
  return c.json({ version: row?.manifest_version ?? 0, updatedAt: row?.updated_at ?? 0 });
});

app.route('/api/auth', auth);
app.route('/api/auth/passkey', passkeys);
app.route('/api/progress', progress);
app.route('/api/preferences', preferences);
app.route('/api/bookmarks', bookmarks);
app.route('/api/push', push);
app.route('/api/admin', admin);
// Admin account bootstrap + recovery (AB#7404) — same /api/admin prefix, own
// router because none of it is admin-session gated: these ARE the routes that
// hand out the first admin session. Registered after `admin` so the paths it
// already owns (/setup, /status, ...) keep their handlers; the three routes
// here (/setup/reset, /setup/claim, /recover) don't overlap with any of them.
app.route('/api/admin', adminAuth);
// Content editing (AB#7420/AB#7421 — plan §3). Same /api/admin prefix, own
// router: it owns /content/* and /upload, every route in it is admin-session
// gated as a group, and none of it shares the ADMIN_KEY exception POST
// /publish carries.
// Brand & theme packages (AB#7417 — plan §0c/§0d Phase 4). Same /api/admin
// prefix, own router: it owns /themes/*, and unlike adminContent it carries the
// same ADMIN_KEY exception POST /publish does, because the CLI import door is a
// headless caller by definition.
//
// Registered BEFORE adminContent, and that order is load-bearing. Hono composes
// every matching middleware in REGISTRATION order, and adminContent gates the
// whole prefix with `use('/*', requireAdmin())` — so mounting it first would
// put a session-only gate in front of these routes and the CLI's ADMIN_KEY door
// would answer 401 no matter what key it sent. (Confirmed against a real
// `wrangler dev`, not reasoned about: it did exactly that.)
app.route('/api/admin', adminThemes);
// The narration queue (AB#7412 — plan §8 item 4). Same /api/admin prefix, own
// router, and registered BEFORE adminContent for exactly the reason spelled out
// above adminThemes: it carries the same ADMIN_KEY door, because the thing that
// drains the queue (packages/pipeline/narrate.mjs) is a headless worker with no
// browser and no cookie, and a session-only gate mounted in front of it would
// answer 401 whatever key it sent.
app.route('/api/admin', adminNarration);
// The Connections surface (wave 2 — content source, repo sync, scoped
// content-API tokens). Session-gated like adminContent, and registered before
// it so its /content-source and /content-tokens paths own their handlers.
app.route('/api/admin', adminSync);
app.route('/api/admin', adminContent);

/**
 * The public content API (AB#7412 — plan §8 item 1), at its own prefix and with
 * its major version IN THE PATH.
 *
 * Deliberately NOT under /api/admin. Everything there is the portal's own
 * surface and moves when the portal moves; this is a contract a publisher's
 * release pipeline pins against, so it gets a URL that says which version it is
 * and a shape that only changes when that number does. Underneath, both doors
 * land in the same lib/content.ts — see routes/content-api.ts.
 */
app.route('/api/content', contentApi);

/**
 * The PWA manifest, generated from the live brand (AB#7415 — plan §0d Phase 2).
 *
 * A real route rather than a rewritten asset, because there is nothing of the
 * built file worth keeping: every field in it comes from brand.json. The static
 * dist/manifest.webmanifest the build still emits is the fallback for contexts
 * with no injector (`vite preview`, a bare static host) and the source of the
 * icon list here, so icon paths stay a build concern.
 *
 * `manifest.webmanifest` was excluded from `run_worker_first` until now; it is
 * back in, which costs one Worker invocation per install prompt — rare enough
 * not to matter, and the alternative is an installed app named after whichever
 * brand happened to be current at the last build.
 */
app.get('/manifest.webmanifest', async (c) => {
  const [brand, baked] = await Promise.all([liveBrand(c.req.raw, c.env), bakedManifest(c.req.raw, c.env)]);
  if (!brand) return serveAsset(c.req.raw, c.env); // no brand asset — serve the built file untouched
  return c.json(manifestFromBrand(brand, baked), 200, {
    'Content-Type': 'application/manifest+json',
    'Cache-Control': 'no-store',
  });
});

/**
 * Same-origin content (AB#7395).
 *
 * Published content lives in the deployment's own storage — the CONTENT R2
 * bucket on Cloudflare — but until now the only way to SERVE it was to give
 * that storage a public domain of its own, which on Cloudflare means an R2
 * custom domain, which means DNS work outside Cloudflare's dashboard before a
 * brand-new deployment can load a single book. These routes close that gap:
 * with `contentOrigin` unset ('' — the scaffold default), `contentUrl()` in
 * the frontend produces root-relative URLs — /manifest.json, /books/… — and
 * they land here, answered straight out of the same bucket the publish
 * pipeline and the portal already write. No custom domain, no DNS, no step 3.
 *
 * Registered for exactly the two path shapes the pipeline writes public
 * content under, and nothing else: the bucket also holds theme state
 * (themes/*), and installed-theme history is not part of the public content
 * contract just because an R2 custom domain would have exposed it.
 *
 * A deployment with a real CONTENT_ORIGIN is untouched — the app never asks
 * this origin for content then — but the routes still answer, so a
 * root-relative image URL pasted into markdown while same-origin keeps
 * resolving after a later move to a custom content domain.
 *
 * Falls through to serveAsset() when the object — or the storage binding —
 * is missing, which is what `publish.mjs --local app/dist` relies on:
 * same-origin content served as plain static assets, no bucket involved.
 */
app.on(['GET', 'HEAD'], ['/manifest.json', '/books/*'], async (c) => {
  return (await serveContent(c.req.raw, c.env)) ?? serveAsset(c.req.raw, c.env);
});

app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
  // Everything that isn't an API route is a static asset (AB#7414). The asset
  // router still resolves it — /admin still lands on admin.html through its own
  // html_handling, an unknown path still falls through to the SPA shell — but
  // it does so via ASSETS.fetch here rather than before the Worker runs, so
  // documents can be stamped with this deployment's live config on the way out.
  return serveAsset(c.req.raw, c.env);
});

/**
 * Serve a static asset with the deployment's current config injected
 * (AB#7414 — plan §0d Phase 1).
 *
 * `run_worker_first` in wrangler.jsonc is what routes requests here at all.
 * Since AB#7418 it is `/*` with no exclusions: /assets/* lost its bypass the
 * way /icons/* did in Phase 4 and for the same reason — an installed engine's
 * hashed bundle lives in the deployment's storage, not in the immutable asset
 * snapshot, so the Worker has to be the one answering. The cost is one Worker
 * invocation per asset request; what keeps that cheap on the (default)
 * deployments with nothing installed is the negative-result cache in
 * installedEngine() below, which makes the per-asset overhead one in-memory
 * check rather than a storage read.
 *
 * Conditional headers are stripped before handing the request on. Without that
 * the asset router would happily answer a revalidating browser with a bodyless
 * 304 — there would be nothing to inject into, and the browser would go on
 * using the copy it cached under the PREVIOUS deployment config. That is the
 * same split brain this whole change exists to close, arriving by a different
 * door.
 */
async function serveAsset(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;

  // ── The installed engine, if any (AB#7418) ────────────────────────────────
  // Resolved ONCE per request, and every engine file this request serves comes
  // from that one version — that single resolution is what makes an update an
  // atomic flip rather than a window where index.html and the hashed bundle
  // disagree. With nothing installed (the default state, negative-cached below)
  // this whole block costs nothing and the build assets serve exactly as they
  // always have.
  const engine = await installedEngine(env);
  if (engine) {
    const key = engineFileKey(engine, path);
    if (key) {
      const file = await readEngineFile(env.CONTENT_STORE!, engine.versionId, key);
      if (file) return engineResponse(request, env, key, file);
      // The active version's archive lost a file it claims to have — a storage
      // fault. Fall through to the build rather than 404 a live site.
    } else if (path.startsWith('/assets/')) {
      // Not in the active version. A client that loaded the PREVIOUS version's
      // HTML just before the flip still requests its hashed assets — versioned
      // prefixes exist precisely so those stay servable until history evicts
      // them. Only after the history also misses does the build get a look.
      const old = await findEngineAsset(env.CONTENT_STORE!, path.replace(/^\/+/, ''));
      if (old) return engineResponse(request, env, path.replace(/^\/+/, ''), old);
    }
  }

  let response = await rawAsset(request, env);

  // Content type, not path, decides which injection applies — a request for
  // /sw.js on a build that has no service worker comes back as the SPA shell,
  // and prepending a JS prelude to HTML would break the page.
  let type = response.headers.get('content-type') ?? '';

  // A hashed-asset request the asset router answered with the SPA shell means
  // the build does not have that file. Before shrugging, re-check the store
  // FRESH (bypassing the negative cache): another isolate may have installed an
  // engine seconds ago, and this client's new HTML is asking for the new
  // bundle. This is the net that makes the ~10s negative cache safe.
  if (path.startsWith('/assets/') && /\btext\/html\b/i.test(type) && env.CONTENT_STORE) {
    const fresh = engine ?? (await installedEngine(env, { fresh: true }));
    if (fresh) {
      const rel = path.replace(/^\/+/, '');
      const found = fresh.files.includes(rel)
        ? await readEngineFile(env.CONTENT_STORE, fresh.versionId, rel)
        : await findEngineAsset(env.CONTENT_STORE, rel);
      if (found) return engineResponse(request, env, rel, found);
    }
  }

  // With an engine installed, EVERY document comes from it — including the SPA
  // shell the asset router hands back for deep links (/library/…), which would
  // otherwise be the build's old HTML referencing the build's old bundle while
  // `/` serves the new one. Substituted here, before injection, so the engine
  // shell flows through exactly the same stamping the build's shell does.
  // (/admin is excluded: it only reaches this point when the engine carries no
  // admin.html at all, and the build's own portal beats a shell with no portal.)
  if (engine && /\btext\/html\b/i.test(type) && !path.startsWith('/icons/') && path !== '/admin') {
    const shell = await readEngineFile(env.CONTENT_STORE!, engine.versionId, 'index.html');
    if (shell) {
      response = new Response(shell.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      type = 'text/html; charset=utf-8';
    }
  }

  // theme.css (AB#7415): the brand's own stylesheet, with the live font
  // selection appended. Served from the asset the deployment ships rather than
  // from the JS bundle, so replacing dist/theme.css restyles the site with no
  // rebuild — which is the whole point of the phase.
  if (path === THEME_ASSET && /\btext\/css\b/i.test(type)) {
    const [built, brand, registry, installed] = await Promise.all([
      response.text(),
      liveBrand(request, env),
      fontRegistry(request, env),
      installedCss(env),
    ]);
    return rewritten(response, themeCssWithFonts(installed ?? built, brand, registry));
  }

  if (path === '/sw.js' && /javascript|ecmascript/i.test(type)) {
    return rewritten(response, await stampedServiceWorker(request, env, await response.text()));
  }

  // Icons from the installed theme (AB#7417). `run_worker_first` gained
  // `/icons/*` in Phase 4 so these can be answered at all: Phase 2 left icon
  // FILES as build assets precisely because swapping them "needs no code, only
  // a file" — and a package import is that file arriving without shell access.
  // With no theme installed this falls through to the asset router's own bytes,
  // one Worker invocation later.
  if (path.startsWith('/icons/') && !path.slice(7).includes('/')) {
    const icon = await installedIcon(env, path.slice(7));
    if (icon) {
      return new Response(icon.body, {
        status: 200,
        headers: {
          'Content-Type': icon.contentType,
          // Short, not immutable: the URL is stable across imports, so a long
          // TTL here is what would leave the previous brand's icon on a phone.
          'Cache-Control': 'public, max-age=60',
        },
      });
    }
    return response;
  }

  if (type.includes('text/html')) {
    return rewritten(response, await stampedDocument(request, env, await response.text()));
  }

  return response;
}

/**
 * A document with the deployment's live config, brand and presentation stamped
 * in — the ONE injection path, shared by build documents and installed-engine
 * documents so the engine's HTML cannot bypass what the build's goes through.
 */
async function stampedDocument(request: Request, env: Env, html: string): Promise<string> {
  const [brand, presentation] = await Promise.all([liveBrand(request, env), livePresentation(request, env)]);
  let out = injectDeploymentIntoHtml(html, deploymentConfigFromEnv(env));
  if (brand) out = injectBrandIntoHtml(out, brand);
  if (presentation) out = injectPresentationIntoHtml(out, presentation);
  return out;
}

/**
 * The service worker with the same three preludes. Presentation, then brand,
 * then deployment — each prepends, so the deployment statement ends up on
 * line 1 where Phase 1's own prelude regex expects to find it.
 */
async function stampedServiceWorker(request: Request, env: Env, js: string): Promise<string> {
  const [brand, presentation] = await Promise.all([liveBrand(request, env), livePresentation(request, env)]);
  let out = presentation ? injectPresentationIntoScript(js, presentation) : js;
  out = brand ? injectBrandIntoScript(out, brand) : out;
  return injectDeploymentIntoScript(out, deploymentConfigFromEnv(env));
}

/** The asset router's answer, with conditional headers stripped (see above). */
async function rawAsset(request: Request, env: Env): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('if-none-match');
  headers.delete('if-modified-since');
  return env.ASSETS.fetch(new Request(request, { headers }));
}

/**
 * Same headers policy as Phase 1's injectDeploymentIntoResponse: `ETag` and
 * `Last-Modified` describe the file on disk and this body is no longer that
 * file, so leaving them would let a client revalidate its way back to a stale
 * copy; `no-store` keeps the rewritten document out of every cache in between.
 */
function rewritten(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete('etag');
  headers.delete('last-modified');
  headers.set('cache-control', 'no-store');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** MIME by extension, for stores that record none (a local content directory). */
const CONTENT_MIME: Record<string, string> = {
  json: 'application/json',
  md: 'text/markdown; charset=utf-8',
  mp3: 'audio/mpeg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/**
 * Serve one published object out of the deployment's own content storage, or
 * undefined for "not here — let the asset router answer".
 *
 * Two drivers, same preference order the rest of the Worker uses:
 *
 *   • The raw CONTENT R2 binding, when Cloudflare bound one. Used directly
 *     rather than through the ContentStore seam because serving is where the
 *     seam's simplicity costs real behavior: `<audio>` seeks with Range
 *     requests, browsers revalidate with If-None-Match, and R2 answers both
 *     natively — buffering whole audio files to slice them here would be the
 *     service worker's 206 synthesis done in the wrong place, per request.
 *   • CONTENT_STORE, for platform entries that bind one without an R2 bucket
 *     (the Azure Node entry, a local directory). Full-body responses only,
 *     which is fine: those platforms serve content from their own public
 *     origin in production, so this path is a dev/fallback door.
 *
 * Cache-control comes from the object's own stored metadata (the pipeline and
 * the portal both write it), with the pipeline's exact policy as the fallback
 * for objects that carry none: the manifest names the whole library so it
 * stays SHORT; every other key is content-hashed and immutable.
 */
async function serveContent(request: Request, env: Env): Promise<Response | undefined> {
  let key: string;
  try {
    key = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
  } catch {
    return undefined; // malformed percent-encoding — not a stored key
  }
  if (!key) return undefined;
  const fallbackCache = key === 'manifest.json' ? SHORT : IMMUTABLE;

  const bucket = env.CONTENT;
  if (bucket) {
    // Engaged only when the request actually sent one: workerd fills in
    // `object.range` for a plain get handed the headers too (confirmed against
    // a real `wrangler dev` — every response came back 206), so the header is
    // both the opt-in and the discriminator for the 206 below.
    const rangeHeader = request.headers.get('range');
    let object: R2Object | R2ObjectBody | null;
    try {
      object =
        request.method === 'HEAD'
          ? await bucket.head(key)
          : await bucket.get(key, { range: rangeHeader ? request.headers : undefined, onlyIf: request.headers });
    } catch {
      // R2 throws on an unsatisfiable/malformed Range — answer it as HTTP does.
      return new Response(null, { status: 416 });
    }
    if (!object) return undefined;

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('accept-ranges', 'bytes');
    if (!headers.has('cache-control')) headers.set('cache-control', fallbackCache);

    if (request.method === 'HEAD') {
      headers.set('content-length', String(object.size));
      return new Response(null, { status: 200, headers });
    }
    // A precondition (onlyIf) that failed comes back as a bodiless R2Object.
    const withBody = 'body' in object ? (object as R2ObjectBody) : undefined;
    if (!withBody?.body) return new Response(null, { status: 304, headers });

    const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
    if (rangeHeader && range) {
      const offset = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
      const length = range.suffix !== undefined ? range.suffix : (range.length ?? object.size - offset);
      headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set('content-length', String(length));
      return new Response(withBody.body, { status: 206, headers });
    }
    headers.set('content-length', String(object.size));
    return new Response(withBody.body, { status: 200, headers });
  }

  const store = env.CONTENT_STORE;
  if (!store) return undefined;
  const object = await store.get(key);
  if (!object) return undefined;
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: 200,
    headers: {
      'Content-Type': object.contentType ?? CONTENT_MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': fallbackCache,
      'Content-Length': String(object.body.byteLength),
    },
  });
}

/**
 * This deployment's brand, read from its own static assets on every request
 * (AB#7415 — plan §0d Phase 2).
 *
 * Per request, not memoised: swapping dist/brand.json is meant to take effect
 * on the next request, and an isolate-lifetime cache would make that "on the
 * next cold start", which is unpredictable and untestable. The cost is one
 * `env.ASSETS.fetch` — a binding call inside the same colo, issued in parallel
 * with the document fetch it accompanies, not a network round trip.
 *
 * Returns undefined when the deployment ships no brand.json (a site built by an
 * older core) or when the file is unusable; callers then skip brand injection
 * and the frontend falls back to the brand baked in at build. A broken file
 * must never take the library down.
 */
async function liveBrand(request: Request, env: Env): Promise<BrandIdentity | undefined> {
  // An imported theme (AB#7417) wins over the build's asset. Deliberately
  // routed through readBrandAsset all the same: the import already validated
  // this object against brand.schema.json in strict mode, but the key whitelist
  // and the value checks in ./lib/brand.ts are the ONE filter that decides what
  // reaches a document, and a second entry point into injection would be a
  // second answer to "which keys are brand".
  const installed = await installedTheme(env);
  if (installed) return readBrandAsset(JSON.stringify(installed.brand));
  const text = await assetText(request, env, BRAND_ASSET);
  return text === undefined ? undefined : readBrandAsset(text);
}

/**
 * This deployment's presentation, read from its own static assets on every
 * request (AB#7416 — plan §0d Phase 3).
 *
 * Per request and not memoised, for exactly the reason liveBrand is: swapping
 * dist/presentation.json is meant to take effect on the NEXT request, and an
 * isolate-lifetime cache would make that "on the next cold start", which is
 * unpredictable and untestable. The cost is one `env.ASSETS.fetch` — a binding
 * call inside the same colo, issued in parallel with the document fetch and the
 * brand read it accompanies, not a network round trip.
 *
 * Returns undefined when the deployment ships no presentation.json (a site built
 * by an older core) or when the file is unusable; callers then skip injection
 * and the frontend falls back to the presentation baked in at build, and beyond
 * that to core's defaults. A broken file must never take the library down.
 */
async function livePresentation(request: Request, env: Env): Promise<PresentationInput | undefined> {
  // A theme package MAY carry a presentation; most do not. When it does, it
  // wins; when it does not, the deployment keeps its own arrangement rather
  // than silently reverting to core defaults — installing a colour scheme is
  // not a request to rearrange the tab bar.
  const installed = await installedTheme(env);
  if (installed?.presentation) return readPresentationAsset(JSON.stringify(installed.presentation));
  const text = await assetText(request, env, PRESENTATION_ASSET);
  return text === undefined ? undefined : readPresentationAsset(text);
}

/**
 * The theme this deployment has installed, or undefined for "wearing the build"
 * (AB#7417 — plan §0d Phase 4).
 *
 * Read per request and not memoised, for exactly the reason liveBrand and
 * livePresentation are: an import — or a rollback — is meant to take effect on
 * the NEXT request, and an isolate-lifetime cache would make that "on the next
 * cold start", which is unpredictable and untestable. The cost is one storage
 * read of a small JSON object, issued in parallel with the document fetch it
 * accompanies.
 *
 * A deployment with no writable storage bound has no installed theme by
 * definition, and short-circuits here without touching anything.
 */
async function installedTheme(env: Env): Promise<ActiveTheme | undefined> {
  const store = env.CONTENT_STORE;
  if (!store) return undefined;
  try {
    return (await readActiveTheme(store)) ?? undefined;
  } catch (err) {
    // A storage blip must not take the site's identity down; the build's own
    // brand is a perfectly good answer and is what every pre-Phase-4 site uses.
    console.warn(`storylark: could not read the installed theme (${(err as Error).message}) — serving the brand this build shipped with.`);
    return undefined;
  }
}

/** The installed theme's stylesheet, or undefined to serve the build's. */
async function installedCss(env: Env): Promise<string | undefined> {
  const [store, active] = [env.CONTENT_STORE, await installedTheme(env)];
  if (!store || !active) return undefined;
  return (await readActiveCss(store, active)) ?? undefined;
}

/** One icon from the installed theme, or undefined to serve the build's. */
async function installedIcon(env: Env, name: string): Promise<{ body: ArrayBuffer; contentType: string } | undefined> {
  const [store, active] = [env.CONTENT_STORE, await installedTheme(env)];
  if (!store || !active) return undefined;
  return (await readActiveIcon(store, active, name)) ?? undefined;
}

// ── The installed engine (AB#7418) ──────────────────────────────────────────

/**
 * The engine this deployment has installed, or undefined for "serving the
 * build". Read per request like the theme; what IS cached — briefly, and in
 * lib/engine-store.ts beside the writers so an install here resets it in the
 * same breath — is the NEGATIVE answer, because `run_worker_first` now routes
 * /assets/* through the Worker and a deployment with nothing installed (the
 * default) should not pay a storage read per font file for a feature it is not
 * using. See readActiveEngineCached for the full accounting; the fresh
 * re-check in serveAsset is what makes the TTL invisible to clients that hold
 * a just-installed engine's HTML.
 */
async function installedEngine(env: Env, opts: { fresh?: boolean } = {}): Promise<ActiveEngine | undefined> {
  const store = env.CONTENT_STORE;
  if (!store) return undefined;
  try {
    return (await readActiveEngineCached(store, opts)) ?? undefined;
  } catch (err) {
    // A storage blip must not take the site down; the build's own assets are a
    // perfectly good answer and are what every pre-engine-store site serves.
    console.warn(`storylark: could not read the installed engine (${(err as Error).message}) — serving the build's own assets.`);
    return undefined;
  }
}

/**
 * Which of the active engine's files answers this path, or undefined for "not
 * an engine file — ask the asset router".
 *
 * Reproduces the two pieces of asset-router behaviour the engine store now
 * fronts: `/` resolves to index.html, and an extensionless path resolves to its
 * .html sibling (which is how /admin lands on admin.html). The literal
 * /index.html and /admin.html are deliberately NOT mapped: the asset router
 * 307s them to their canonical URLs, and it still can, because the build always
 * carries both files.
 */
function engineFileKey(engine: ActiveEngine, path: string): string | undefined {
  if (path === '/') return engine.files.includes('index.html') ? 'index.html' : undefined;
  let p: string;
  try {
    p = decodeURIComponent(path).replace(/^\/+/, '');
  } catch {
    return undefined; // malformed percent-encoding — not an engine file
  }
  if (p === 'index.html' || p === 'admin.html') return undefined;
  if (engine.files.includes(p)) return p;
  if (!p.includes('.') && !p.includes('/') && engine.files.includes(`${p}.html`)) return `${p}.html`;
  return undefined;
}

/**
 * Serve one installed-engine file, through exactly the treatment its build-asset
 * counterpart would get: documents and the service worker flow through the same
 * stamping (stampedDocument / stampedServiceWorker), hashed assets are
 * immutable, and everything else is short-lived like the other rewritten-in-
 * place keys the store holds.
 */
async function engineResponse(
  request: Request,
  env: Env,
  key: string,
  file: { body: ArrayBuffer; contentType: string }
): Promise<Response> {
  if (key.endsWith('.html')) {
    const out = await stampedDocument(request, env, new TextDecoder().decode(file.body));
    return new Response(request.method === 'HEAD' ? null : out, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (key === 'sw.js') {
    const out = await stampedServiceWorker(request, env, new TextDecoder().decode(file.body));
    return new Response(request.method === 'HEAD' ? null : out, {
      status: 200,
      headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const headers = new Headers({
    'Content-Type': file.contentType,
    // Hashed filenames are immutable by construction; everything else in an
    // engine (fonts.json, outputs.json) is a stable URL whose content moves
    // when the active version does, so it gets the same short TTL as
    // active.json itself.
    'Cache-Control': key.startsWith('assets/') ? IMMUTABLE : SHORT,
    'Content-Length': String(file.body.byteLength),
  });
  return new Response(request.method === 'HEAD' ? null : file.body, { status: 200, headers });
}

/**
 * The curated font registry, memoised for the life of the isolate.
 *
 * Unlike the brand this is ENGINE data: dist/fonts.json is emitted from
 * storylark-core's font registry by the same build that shipped the font files,
 * so it can only change when the site is rebuilt and redeployed — which starts
 * new isolates anyway. Caching it keeps the per-request cost of /theme.css at
 * one asset read rather than two.
 */
let fontRegistryCache: { key: string; registry: FontRegistry | undefined } | null = null;
async function fontRegistry(request: Request, env: Env): Promise<FontRegistry | undefined> {
  // An installed engine (AB#7418) breaks the "only a rebuild can change it"
  // assumption above — its dist/fonts.json replaces the build's — so the memo
  // is keyed by which engine is active rather than being unconditional. The
  // active-engine read is already paid by the /theme.css request this
  // accompanies; this only decides which fonts.json the memo holds.
  const engine = await installedEngine(env);
  const key = engine?.versionId ?? 'build';
  if (fontRegistryCache?.key === key) return fontRegistryCache.registry;
  let text: string | undefined;
  if (engine && engine.files.includes(FONTS_ASSET.replace(/^\//, ''))) {
    const file = await readEngineFile(env.CONTENT_STORE!, engine.versionId, FONTS_ASSET.replace(/^\//, ''));
    text = file ? new TextDecoder().decode(file.body) : undefined;
  } else {
    text = await assetText(request, env, FONTS_ASSET);
  }
  fontRegistryCache = { key, registry: text === undefined ? undefined : readFontRegistry(text) };
  return fontRegistryCache.registry;
}

/** The built manifest, for the icon list Phase 2 leaves as a build concern. */
async function bakedManifest(request: Request, env: Env): Promise<Record<string, unknown> | undefined> {
  const text = await assetText(request, env, '/manifest.webmanifest');
  if (text === undefined) return undefined;
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    return doc && typeof doc === 'object' ? doc : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read one static asset as text.
 *
 * `env.ASSETS.fetch` on a missing path does not 404 here — `not_found_handling`
 * is `single-page-application`, so it answers with the app shell. The
 * content-type check is what distinguishes "no such asset" from "the asset",
 * and it is why this returns undefined rather than an empty string: an HTML
 * body parsed as brand JSON would produce a warning on every single request.
 */
async function assetText(request: Request, env: Env, path: string): Promise<string | undefined> {
  const response = await env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: { accept: '*/*' } }));
  if (!response.ok) return undefined;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/html')) return undefined; // SPA fallback — the asset is not there
  return response.text();
}

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal' }, 500);
});

// The raw Hono app, for platform entries that already hand it a conforming
// Env (Database & ConflictInsert) — platforms/azure/server.mjs binds env.DB
// to postgresDatabase(...) directly and calls app.fetch itself. Exported so
// non-Cloudflare entries never go through the D1-specific wrap below.
export { app };

// Cloudflare hands the raw D1Database binding declared in wrangler.jsonc;
// wrap it in the platform-agnostic Database seam (AB#7399) before any route
// sees it. This default export is Cloudflare-only — other platforms use the
// named `app` export above with their own driver already bound.
export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    // Mutate the DB property on the SAME object Cloudflare handed us,
    // in place — no spread, no Proxy. Both were tried and both broke
    // sub-router env access in local `wrangler dev` (confirmed live: routes
    // mounted via app.route(), e.g. /api/admin/*, silently never ran —
    // no console.log even at the top of the handler — while top-level
    // routes like /api/health worked fine through the same wrapper). A
    // spread also has the separate, real problem of dropping non-enumerable
    // secrets. In-place mutation has neither failure mode: it's the exact
    // object reference the runtime already wired up everywhere.
    const raw = env as Env & { DB: D1Database };
    (raw as unknown as { DB: unknown }).DB = d1Database(raw.DB);
    // Same in-place treatment for the content seam (AB#7420): the CONTENT R2
    // binding this Worker already has IS its writable content storage, so the
    // portal's editing routes need no credential and no new configuration on
    // Cloudflare. A deployment whose wrangler config declares no bucket simply
    // leaves this undefined and those routes report that plainly.
    if (raw.CONTENT && !raw.CONTENT_STORE) raw.CONTENT_STORE = r2ContentStore(raw.CONTENT);
    // One-click updates (AB#7418), Cloudflare side. Bound only when the
    // operator has put a Cloudflare API token on this Worker as a secret —
    // there is no default, no fallback and nothing to disable, because a
    // deployment with no token simply has no deployer. Same in-place mutation
    // as the two above, for the same reason.
    if (!raw.SELF_DEPLOY && raw.CF_API_TOKEN && raw.CF_ACCOUNT_ID) raw.SELF_DEPLOY = cloudflareSelfDeploy(raw as Env);
    return app.fetch(request, raw as Env, ctx);
  },

  // Operator notifications (AB#7403/F2), Cloudflare side: a Cron Trigger
  // (see wrangler.jsonc `triggers.crons`) invokes this instead of fetch.
  // Same env, same check as the in-portal GET /api/admin/update-status —
  // this just also emails the operator when RESEND_API_KEY + ADMIN_EMAIL
  // are configured, so they hear about it without opening /admin.
  //
  // Content sync (wave 2 — design §10.3) is a SECOND JOB on this same cron,
  // deliberately: §6.4's whole argument is no new infrastructure, so the
  // schedule stays `0 13 * * *` and the sync job self-gates on its configured
  // interval. A deployment with no repo connection pays one database read and
  // does nothing.
  async scheduled(_event: ScheduledEvent, env: unknown, ctx: ExecutionContext) {
    // The same in-place binding fetch() performs: Cloudflare hands the raw D1
    // binding and the raw R2 bucket; the sync job needs the seams.
    const raw = env as Env & { DB: D1Database };
    if (!(raw.DB as unknown as { insertIgnore?: unknown }).insertIgnore) {
      (raw as unknown as { DB: unknown }).DB = d1Database(raw.DB);
    }
    if (raw.CONTENT && !raw.CONTENT_STORE) raw.CONTENT_STORE = r2ContentStore(raw.CONTENT);
    ctx.waitUntil(Promise.allSettled([checkForUpdateAndNotify(raw), scheduledContentSync(raw)]));
  },
};
