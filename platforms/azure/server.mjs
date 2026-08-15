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
import { Hono } from 'hono';
import { app as workerApp } from 'storylark-worker';
import { postgresDatabase } from 'storylark-worker/db/postgres';
import { checkForUpdateAndNotify } from 'storylark-worker/lib/update-check';

const required = ['DATABASE_URL', 'BRAND', 'APP_ORIGIN', 'CONTENT_ORIGIN', 'MAIL_FROM', 'APP_NAME'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}\nSee platforms/azure/.env.example.`);
  process.exit(1);
}

const db = postgresDatabase(process.env.DATABASE_URL);

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
app.use('/api/*', async (c) => workerApp.fetch(c.req.raw, env, executionCtx));
app.use('/*', serveStatic({ root: process.env.STATIC_ROOT ?? './app/dist' }));

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
