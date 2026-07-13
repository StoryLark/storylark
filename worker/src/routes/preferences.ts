import { Hono } from 'hono';
import type { AppContext } from '../types';
import { requireAuth } from '../lib/session';

/**
 * Account-synced user preferences: a small JSON blob (default playback mode,
 * read-along, theme, font scale, line height) stored per user. Same last-
 * writer-wins-on-updatedAt shape as progress, so offline edits and races
 * across devices converge on the newest state.
 */
export const preferences = new Hono<AppContext>();
preferences.use('*', requireAuth());

preferences.get('/', async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare('SELECT prefs, updated_at FROM user_preferences WHERE user_id = ?')
    .bind(user.id)
    .first<{ prefs: string; updated_at: number }>();
  let prefs: Record<string, unknown> = {};
  if (row?.prefs) {
    try {
      prefs = JSON.parse(row.prefs) as Record<string, unknown>;
    } catch {
      prefs = {};
    }
  }
  return c.json({ prefs, updatedAt: row?.updated_at ?? null });
});

preferences.put('/', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  const user = c.get('user');
  const body = await c.req.json<{ prefs?: Record<string, unknown>; updatedAt?: number }>().catch(() => null);
  if (!body || typeof body.prefs !== 'object' || body.prefs === null) return c.json({ error: 'bad_request' }, 400);
  const updatedAt = typeof body.updatedAt === 'number' ? body.updatedAt : Date.now();

  await c.env.DB.prepare(
    `INSERT INTO user_preferences (user_id, prefs, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at
     WHERE excluded.updated_at > user_preferences.updated_at`
  )
    .bind(user.id, JSON.stringify(body.prefs), updatedAt)
    .run();
  return c.json({ ok: true });
});
