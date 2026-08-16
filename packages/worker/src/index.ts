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
import { checkForUpdateAndNotify } from './lib/update-check';
import { deploymentConfigFromEnv, injectDeploymentIntoResponse } from './lib/deployment';

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
  const headers = new Headers(request.headers);
  headers.delete('if-none-match');
  headers.delete('if-modified-since');
  const response = await env.ASSETS.fetch(new Request(request, { headers }));

  // Content type, not path, decides which injection applies — a request for
  // /sw.js on a build that has no service worker comes back as the SPA shell,
  // and prepending a JS prelude to HTML would break the page.
  const type = response.headers.get('content-type') ?? '';
  if (new URL(request.url).pathname === '/sw.js' && /javascript|ecmascript/i.test(type)) {
    return injectDeploymentIntoResponse(response, deploymentConfigFromEnv(env), 'script');
  }
  if (type.includes('text/html')) {
    return injectDeploymentIntoResponse(response, deploymentConfigFromEnv(env), 'html');
  }
  return response;
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
