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
  // Non-API paths under run_worker_first shouldn't occur, but fall back to assets.
  return c.env.ASSETS.fetch(c.req.raw);
});

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
