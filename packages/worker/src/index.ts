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
import { r2ContentStore } from './lib/content-store';
import { checkForUpdateAndNotify } from './lib/update-check';
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
app.route('/api/admin', adminContent);

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
 * `run_worker_first` in wrangler.jsonc is what routes documents here at all:
 * it lists `/*` minus the hashed-asset directories, so navigations, /admin and
 * /sw.js reach the Worker while /assets/*, /icons/* and manifest.webmanifest
 * keep being served straight off the asset router with no Worker invocation.
 *
 * Conditional headers are stripped before handing the request on. Without that
 * the asset router would happily answer a revalidating browser with a bodyless
 * 304 — there would be nothing to inject into, and the browser would go on
 * using the copy it cached under the PREVIOUS deployment config. That is the
 * same split brain this whole change exists to close, arriving by a different
 * door.
 */
async function serveAsset(request: Request, env: Env): Promise<Response> {
  const response = await rawAsset(request, env);

  // Content type, not path, decides which injection applies — a request for
  // /sw.js on a build that has no service worker comes back as the SPA shell,
  // and prepending a JS prelude to HTML would break the page.
  const type = response.headers.get('content-type') ?? '';
  const path = new URL(request.url).pathname;

  // theme.css (AB#7415): the brand's own stylesheet, with the live font
  // selection appended. Served from the asset the deployment ships rather than
  // from the JS bundle, so replacing dist/theme.css restyles the site with no
  // rebuild — which is the whole point of the phase.
  if (path === THEME_ASSET && /\btext\/css\b/i.test(type)) {
    const [css, brand, registry] = await Promise.all([
      response.text(),
      liveBrand(request, env),
      fontRegistry(request, env),
    ]);
    return rewritten(response, themeCssWithFonts(css, brand, registry));
  }

  if (path === '/sw.js' && /javascript|ecmascript/i.test(type)) {
    const [js, brand, presentation] = await Promise.all([
      response.text(),
      liveBrand(request, env),
      livePresentation(request, env),
    ]);
    // Presentation, then brand, then deployment — each prepends, so the
    // deployment statement ends up on line 1 where Phase 1's own prelude regex
    // expects to find it.
    let out = presentation ? injectPresentationIntoScript(js, presentation) : js;
    out = brand ? injectBrandIntoScript(out, brand) : out;
    return rewritten(response, injectDeploymentIntoScript(out, deploymentConfigFromEnv(env)));
  }

  if (type.includes('text/html')) {
    const [html, brand, presentation] = await Promise.all([
      response.text(),
      liveBrand(request, env),
      livePresentation(request, env),
    ]);
    let out = injectDeploymentIntoHtml(html, deploymentConfigFromEnv(env));
    if (brand) out = injectBrandIntoHtml(out, brand);
    if (presentation) out = injectPresentationIntoHtml(out, presentation);
    return rewritten(response, out);
  }

  return response;
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
  const text = await assetText(request, env, PRESENTATION_ASSET);
  return text === undefined ? undefined : readPresentationAsset(text);
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
let fontRegistryCache: FontRegistry | undefined | null = null;
async function fontRegistry(request: Request, env: Env): Promise<FontRegistry | undefined> {
  if (fontRegistryCache !== null) return fontRegistryCache;
  const text = await assetText(request, env, FONTS_ASSET);
  fontRegistryCache = text === undefined ? undefined : readFontRegistry(text);
  return fontRegistryCache;
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
    return app.fetch(request, raw as Env, ctx);
  },

  // Operator notifications (AB#7403/F2), Cloudflare side: a Cron Trigger
  // (see wrangler.jsonc `triggers.crons`) invokes this instead of fetch.
  // Same env, same check as the in-portal GET /api/admin/update-status —
  // this just also emails the operator when RESEND_API_KEY + ADMIN_EMAIL
  // are configured, so they hear about it without opening /admin.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkForUpdateAndNotify(env));
  },
};
