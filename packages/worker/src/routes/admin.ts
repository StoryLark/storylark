import { Hono } from 'hono';
import type { AppContext } from '../types';
import { sendPush } from '../lib/vapid';
import { INIT_SCHEMA } from '../lib/schema';

export const admin = new Hono<AppContext>();

/**
 * One-shot database bootstrap through the worker's own D1 binding, for when
 * API-token D1 access is unavailable. Idempotent: no-ops if the schema exists.
 */
admin.post('/setup', async (c) => {
  if (c.req.header('x-admin-key') !== c.env.ADMIN_KEY || !c.env.ADMIN_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const existing = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
  ).first();
  if (existing) return c.json({ ok: true, alreadySetUp: true });

  const statements = INIT_SCHEMA.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const sql of statements) {
    await c.env.DB.prepare(sql).run();
  }
  return c.json({ ok: true, statements: statements.length });
});

/**
 * Called by tools/publish.mjs after a successful upload: bumps the library
 * version and wakes every push subscription (payload-less — the service
 * worker fetches the new manifest itself and composes the notification).
 */
admin.post('/publish', async (c) => {
  if (c.req.header('x-admin-key') !== c.env.ADMIN_KEY || !c.env.ADMIN_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json<{ version?: number }>().catch(() => null);
  if (!body || typeof body.version !== 'number') return c.json({ error: 'bad_request' }, 400);

  await c.env.DB.prepare('UPDATE library_state SET manifest_version = ?, updated_at = ? WHERE id = 1')
    .bind(body.version, Date.now())
    .run();

  const { results } = await c.env.DB.prepare('SELECT endpoint, failed_count FROM push_subscriptions').all<{
    endpoint: string;
    failed_count: number;
  }>();

  // VAPID contact subject — derived from the app origin's registrable domain
  // (app.example.com → example.com) so it stays brand-neutral.
  const subject = `mailto:noreply@${new URL(c.env.APP_ORIGIN).hostname.replace(/^app\./, '')}`;
  c.executionCtx.waitUntil(fanOut(c.env, results, subject));
  return c.json({ ok: true, version: body.version, subscriptions: results.length });
});

async function fanOut(
  env: AppContext['Bindings'],
  subs: { endpoint: string; failed_count: number }[],
  subject: string
): Promise<void> {
  const BATCH = 50;
  for (let i = 0; i < subs.length; i += BATCH) {
    await Promise.all(
      subs.slice(i, i + BATCH).map(async (s) => {
        try {
          const status = await sendPush(s.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, subject);
          if (status === 404 || status === 410) {
            await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(s.endpoint).run();
          } else if (status >= 400) {
            await bumpFailure(env.DB, s.endpoint, s.failed_count);
          }
        } catch {
          await bumpFailure(env.DB, s.endpoint, s.failed_count);
        }
      })
    );
  }
}

async function bumpFailure(db: D1Database, endpoint: string, current: number): Promise<void> {
  if (current + 1 >= 5) {
    await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
  } else {
    await db.prepare('UPDATE push_subscriptions SET failed_count = failed_count + 1 WHERE endpoint = ?').bind(endpoint).run();
  }
}
