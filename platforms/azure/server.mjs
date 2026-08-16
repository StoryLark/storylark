#!/usr/bin/env node
// Azure entry point (AB#7399/A3). Runs the same storylark-worker Hono app
// used on Cloudflare, over plain Node via @hono/node-server (Hono's official
// Node adapter) — the standard way to run Hono on Azure App Service or
// Container Apps, since Hono ships no Azure Functions adapter (its official
// adapters are Cloudflare, Deno, Bun, Vercel, Netlify, and AWS Lambda).
//
// Run with `npm start` (tsx server.mjs), not plain `node server.mjs`:
// storylark-worker's source uses extensionless relative imports, resolved by
// Vite/Wrangler's bundlers everywhere else it's consumed. tsx (esbuild)
// gives this entry the same bundler-style resolution + TS stripping with no
// build step and no changes to the worker package's import style.
//
// Config comes from environment variables instead of wrangler bindings; see
// platforms/azure/.env.example for the full list. Static assets (the built
// PWA in app/dist) are served by whatever's in front of this process in
// production (Azure Static Web Apps / a CDN) — for local/dev use this also
// serves app/dist directly so `node platforms/azure/server.mjs` is a
// complete standalone way to run a branded site.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { app as workerApp } from 'storylark-worker';
import { postgresDatabase } from 'storylark-worker/db/postgres';
import { checkForUpdateAndNotify } from 'storylark-worker/lib/update-check';
import { contentStoreFromEnv } from './content-store.mjs';

// Serve-time deployment config (AB#7414) arrived in storylark-worker 0.9.0.
// This process runs its own `npm install` and can legitimately be a version
// behind mid-update — the same reason /admin falls back to the app shell below
// — so an older worker package degrades to the build-time config instead of
// failing to boot. Imported dynamically for exactly that reason; a static
// import would make the whole site refuse to start.
let deploymentConfigFromEnv = () => ({});
let injectDeploymentIntoHtml = (html) => html;
let injectDeploymentIntoScript = (js) => js;
try {
  ({ deploymentConfigFromEnv, injectDeploymentIntoHtml, injectDeploymentIntoScript } = await import(
    'storylark-worker/lib/deployment'
  ));
} catch {
  console.warn(
    'storylark: this storylark-worker has no lib/deployment (needs >= 0.9.0). Serving the deployment config that was baked in at build — changing APP_ORIGIN/CONTENT_ORIGIN will not reach the frontend until storylark-worker is updated.'
  );
}

// Serve-time brand identity (AB#7415 — plan §0d Phase 2) arrived in
// storylark-worker 0.10.0. Same dynamic-import reasoning as above: this process
// installs its own dependencies and can legitimately be a version behind
// mid-update, and an older worker package must degrade to the brand baked into
// the bundle rather than refuse to start.
let brandLib = null;
try {
  brandLib = await import('storylark-worker/lib/brand');
} catch {
  console.warn(
    'storylark: this storylark-worker has no lib/brand (needs >= 0.10.0). Serving the brand that was baked in at build — swapping brand.json or theme.css will not reach the frontend until storylark-worker is updated.'
  );
}

// Serve-time presentation (AB#7416 — plan §0d Phase 3) arrived in
// storylark-worker 0.11.0. Same dynamic-import reasoning again: an older worker
// package must degrade to the arrangement baked into the bundle rather than
// refuse to start.
let presentationLib = null;
try {
  presentationLib = await import('storylark-worker/lib/presentation');
} catch {
  console.warn(
    'storylark: this storylark-worker has no lib/presentation (needs >= 0.11.0). Serving the presentation that was baked in at build — swapping presentation.json will not reach the frontend until storylark-worker is updated.'
  );
}

const required = ['DATABASE_URL', 'BRAND', 'APP_ORIGIN', 'CONTENT_ORIGIN', 'MAIL_FROM', 'APP_NAME'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}\nSee platforms/azure/.env.example.`);
  process.exit(1);
}

const db = postgresDatabase(process.env.DATABASE_URL);

const { store: contentStore, driver: contentDriver } = contentStoreFromEnv(process.env);
console.log(
  contentDriver
    ? `storylark: content editing enabled — storage driver ${contentDriver}.`
    : 'storylark: no content storage configured (set AZURE_STORAGE_CONNECTION_STRING or STORYLARK_LOCAL_CONTENT) — /admin can read the library but not edit it.'
);

const env = {
  DB: db,
  BRAND: process.env.BRAND,
  APP_ORIGIN: process.env.APP_ORIGIN,
  CONTENT_ORIGIN: process.env.CONTENT_ORIGIN,
  MAIL_FROM: process.env.MAIL_FROM,
  APP_NAME: process.env.APP_NAME,
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? '',
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
  ADMIN_KEY: process.env.ADMIN_KEY ?? '',
  // Self-update + admin-portal story upload (AB#7403/AB#7404) — optional,
  // both features degrade to 501 without these.
  GITHUB_REPO: process.env.GITHUB_REPO ?? '',
  GITHUB_DEPLOY_TOKEN: process.env.GITHUB_DEPLOY_TOKEN ?? '',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? '',
  // Portal content editing (AB#7420/AB#7421). Optional: without a storage
  // driver the site serves content exactly as before and the portal's content
  // routes answer 501 with an explanation. Cloudflare binds this from its R2
  // binding inside the worker; here the credential belongs to this process, so
  // the binding is made here. See ./content-store.mjs.
  CONTENT_STORE: contentStore,
  CONTENT_REVISIONS: process.env.CONTENT_REVISIONS ?? '',
  CONTENT_MAX_UPLOAD_BYTES: process.env.CONTENT_MAX_UPLOAD_BYTES ?? '',
};

// Cloudflare's ExecutionContext.waitUntil() keeps the isolate alive after
// the response returns so background work (push fan-out, email sends —
// routes/admin.ts, routes/auth.ts) can finish; @hono/node-server has no such
// concept because the Node process doesn't tear down between requests. This
// polyfill just runs the promise and logs failures instead of throwing, so a
// failed background send never crashes the process or the request.
const executionCtx = {
  waitUntil(promise) {
    promise.catch((err) => console.error('Background task failed:', err));
  },
  passThroughOnException() {},
};

const app = new Hono();
// storylark-worker's own app.fetch takes (request, env, ctx) directly — env
// here is already a conforming Database & ConflictInsert (postgresDatabase),
// so this bypasses the Cloudflare-specific D1-wrap in the worker's default
// export entirely.
const staticRoot = process.env.STATIC_ROOT ?? './app/dist';
app.use('/api/*', async (c) => workerApp.fetch(c.req.raw, env, executionCtx));

// The admin portal is its own page and its own bundle (AB#7404), so /admin
// must serve admin.html — NOT the app shell the SPA fallback below hands out.
// Cloudflare's asset router does this natively: with html_handling at its
// default (auto-trailing-slash) a request for /admin resolves to the
// /admin.html asset before not_found_handling ever runs, and both /admin/ and
// /admin.html 307 back to the canonical /admin (verified against a real
// `wrangler dev`). These three routes reproduce that behaviour exactly, so
// the URL an operator bookmarks behaves the same on either platform.
/**
 * This deployment's live config (AB#7414 — plan §0d Phase 1), read from the
 * process environment rather than from the values compiled into the bundle.
 * Change CONTENT_ORIGIN in the App Service application settings and the
 * frontend picks it up on the next request, with no rebuild and no redeploy of
 * app/dist — which until now was the one thing the backend could do and the
 * frontend could not.
 *
 * Resolved once, at startup, because that IS request time here: changing an
 * App Service application setting restarts the process, so there is no state
 * in which process.env has moved on and this has not.
 */
const deployment = deploymentConfigFromEnv(process.env);

/**
 * This deployment's brand (AB#7415 — plan §0d Phase 2), read from
 * <staticRoot>/brand.json on EVERY request.
 *
 * Unlike the deployment config above, this is deliberately not resolved once at
 * startup. Its source is a file, not the process environment: an operator (or,
 * later, the admin portal) replaces brand.json on the deployed site and the
 * next request must serve the new brand. Caching it would turn "swap the file"
 * back into "swap the file and restart the app", which is most of what Phase 2
 * exists to delete. A ~400-byte read per request out of the OS page cache is
 * not a cost worth trading that for.
 *
 * A missing or broken file yields undefined, and every caller then falls back
 * to what the build baked in — the same rule Phase 1 uses for a bad env var.
 */
async function liveBrand() {
  if (!brandLib) return undefined;
  const text = await readFile(`${staticRoot}/brand.json`, 'utf8').catch(() => null);
  return text === null ? undefined : brandLib.readBrandAsset(text);
}

/**
 * This deployment's presentation (AB#7416 — plan §0d Phase 3), read from
 * <staticRoot>/presentation.json on EVERY request, for the same reason
 * liveBrand() is: its source is a file, not the process environment, so an
 * operator (or, later, the admin portal) replacing it must take effect on the
 * next request rather than on the next restart. Caching it would turn "swap the
 * file" back into "swap the file and restart the app", which is most of what
 * this phase exists to delete.
 */
async function livePresentation() {
  if (!presentationLib) return undefined;
  const text = await readFile(`${staticRoot}/presentation.json`, 'utf8').catch(() => null);
  return text === null ? undefined : presentationLib.readPresentationAsset(text);
}

/**
 * The curated font registry, read once. Engine data emitted by the site build
 * (dist/fonts.json), so it can only change when the site is rebuilt — and a new
 * site build on App Service means a new process.
 */
let fontRegistry;
async function fonts() {
  if (fontRegistry === undefined && brandLib) {
    const text = await readFile(`${staticRoot}/fonts.json`, 'utf8').catch(() => null);
    fontRegistry = text === null ? null : (brandLib.readFontRegistry(text) ?? null);
  }
  return fontRegistry ?? undefined;
}

/** An HTML document, with the deployment config, the live brand and the live presentation stamped in. */
async function document(c, body) {
  if (body == null) return c.notFound();
  c.header('Cache-Control', 'no-store');
  let out = injectDeploymentIntoHtml(body, deployment);
  const [brand, presentation] = await Promise.all([liveBrand(), livePresentation()]);
  if (brand) out = brandLib.injectBrandIntoHtml(out, brand);
  if (presentation) out = presentationLib.injectPresentationIntoHtml(out, presentation);
  return c.html(out);
}

const htmlCache = new Map();
async function html(name) {
  if (!htmlCache.has(name)) {
    const body = await readFile(`${staticRoot}/${name}`, 'utf8').catch(() => null);
    if (body === null) console.warn(`No ${staticRoot}/${name} — rebuild the site.`);
    htmlCache.set(name, body); // cached either way, warning included: once, not per request
  }
  return htmlCache.get(name);
}
app.get('/admin', async (c) => {
  // Falls back to the app shell — what /admin did before the portal became
  // its own page — if a build from an older storylark-core has no admin.html.
  // This process serves assets it didn't build, so the two can legitimately
  // be a version apart mid-update; a 500 there would be the wrong answer.
  return document(c, (await html('admin.html')) ?? (await html('index.html')));
});
app.get('/admin/', (c) => c.redirect('/admin', 307));
app.get('/admin.html', (c) => c.redirect('/admin', 307));
// Every route that can produce the app shell has to be claimed BEFORE
// serveStatic (AB#7414): its directory-index handling answers `/` with
// app/dist/index.html straight off disk, which would skip the injection for the
// single most-requested URL on the site. `/index.html` redirects to `/` for the
// same reason plus parity — Cloudflare's default html_handling already does it,
// so there is one canonical URL for the shell on both platforms.
app.get('/', async (c) => document(c, await html('index.html')));
app.get('/index.html', (c) => c.redirect('/', 307));

// The service worker gets the same deployment config as the documents, as a
// prelude on the script (AB#7414). It needs the content origin synchronously
// inside its fetch handler and has no document to read a global out of, so the
// script itself is the only place to put it. Registered ahead of serveStatic,
// which would otherwise serve the built file untouched.
app.get('/sw.js', async (c) => {
  const js = await readFile(`${staticRoot}/sw.js`, 'utf8').catch(() => null);
  if (js === null) return c.notFound();
  c.header('Content-Type', 'text/javascript; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  // Presentation, then brand, then deployment — each prepends, so the
  // deployment statement ends up on line 1 where Phase 1's own prelude regex
  // expects to find it.
  const [brand, presentation] = await Promise.all([liveBrand(), livePresentation()]);
  let out = presentation ? presentationLib.injectPresentationIntoScript(js, presentation) : js;
  out = brand ? brandLib.injectBrandIntoScript(out, brand) : out;
  return c.body(injectDeploymentIntoScript(out, deployment));
});

// The brand's stylesheet, with the live font selection appended (AB#7415).
// Claimed before serveStatic for the same reason `/` is: served off disk it
// would be the file the build wrote, and the font selection in it would be
// whichever brand was current at build time.
app.get('/theme.css', async (c) => {
  const css = await readFile(`${staticRoot}/theme.css`, 'utf8').catch(() => null);
  if (css === null) return c.notFound();
  c.header('Content-Type', 'text/css; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  if (!brandLib) return c.body(css);
  const [brand, registry] = await Promise.all([liveBrand(), fonts()]);
  return c.body(brandLib.themeCssWithFonts(css, brand, registry));
});

// The PWA manifest, generated from the live brand rather than served as the
// file the build emitted — so a swapped brand.json changes the installed app's
// name, short name, description and colours with no rebuild.
app.get('/manifest.webmanifest', async (c) => {
  const baked = await readFile(`${staticRoot}/manifest.webmanifest`, 'utf8').catch(() => null);
  const brand = await liveBrand();
  if (!brandLib || !brand) {
    if (baked === null) return c.notFound();
    c.header('Content-Type', 'application/manifest+json');
    return c.body(baked);
  }
  let bakedDoc;
  try {
    bakedDoc = baked === null ? undefined : JSON.parse(baked);
  } catch {
    bakedDoc = undefined;
  }
  c.header('Cache-Control', 'no-store');
  return c.json(brandLib.manifestFromBrand(brand, bakedDoc), 200, {
    'Content-Type': 'application/manifest+json',
  });
});

app.use('/*', serveStatic({ root: staticRoot }));
// SPA fallback for the reader app: Cloudflare's Workers+Assets binding does
// this natively (not_found_handling: "single-page-application" in
// wrangler.jsonc) — the Node server needs it spelled out. Without this, any
// client-side route (e.g. /library/<id>, /read/<book>/<chapter>) 404s instead
// of serving the app shell and letting the router take over.
app.get('*', async (c) => document(c, await html('index.html')));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`StoryLark (${env.APP_NAME}) listening on http://localhost:${info.port}`);
});

// Operator notifications (AB#7403/F2), Azure side: this process stays warm
// (App Service Always On), so a daily interval does the same job
// Cloudflare's Cron Trigger does. No-ops without RESEND_API_KEY +
// ADMIN_EMAIL configured; failures are logged, never crash the process.
const DAY_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  checkForUpdateAndNotify(env).catch((err) => console.error('Update check failed:', err));
}, DAY_MS);
