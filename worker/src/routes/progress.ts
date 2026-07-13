import { Hono } from 'hono';
import type { AppContext, ProgressRow } from '../types';
import { requireAuth } from '../lib/session';

export const progress = new Hono<AppContext>();
progress.use('*', requireAuth());

progress.get('/', async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    'SELECT book_id, chapter_id, mode, char_offset, audio_ms, percent, updated_at FROM progress WHERE user_id = ?'
  )
    .bind(user.id)
    .all<ProgressRow>();
  return c.json({ progress: results });
});

progress.put('/:bookId/:chapterId', async (c) => {
  const user = c.get('user');
  const { bookId, chapterId } = c.req.param();
  const body = await c.req
    .json<{ mode?: string; charOffset?: number; audioMs?: number; percent?: number; updatedAt?: number }>()
    .catch(() => null);
  if (!body || typeof body.updatedAt !== 'number') return c.json({ error: 'bad_request' }, 400);

  const mode = body.mode === 'listen' ? 'listen' : 'read';
  const charOffset = clampInt(body.charOffset);
  const audioMs = clampInt(body.audioMs);
  const percent = Math.min(1, Math.max(0, Number(body.percent) || 0));

  // Last-writer-wins keyed on the client-supplied updatedAt, so offline
  // replays and races between devices always converge on the newest state.
  await c.env.DB.prepare(
    `INSERT INTO progress (user_id, book_id, chapter_id, mode, char_offset, audio_ms, percent, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id, chapter_id) DO UPDATE SET
       mode = excluded.mode, char_offset = excluded.char_offset, audio_ms = excluded.audio_ms,
       percent = excluded.percent, updated_at = excluded.updated_at
     WHERE excluded.updated_at > progress.updated_at`
  )
    .bind(user.id, bookId, chapterId, mode, charOffset, audioMs, percent, body.updatedAt)
    .run();

  const row = await c.env.DB.prepare(
    'SELECT book_id, chapter_id, mode, char_offset, audio_ms, percent, updated_at FROM progress WHERE user_id = ? AND book_id = ? AND chapter_id = ?'
  )
    .bind(user.id, bookId, chapterId)
    .first<ProgressRow>();
  return c.json({ progress: row });
});

function clampInt(v: unknown): number {
  const n = Math.floor(Number(v) || 0);
  return n < 0 ? 0 : n;
}
