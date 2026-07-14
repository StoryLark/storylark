import { Hono } from 'hono';
import type { AppContext } from '../types';
import { requireAuth } from '../lib/session';

export const bookmarks = new Hono<AppContext>();
bookmarks.use('*', requireAuth());

bookmarks.get('/', async (c) => {
  const user = c.get('user');
  const bookId = c.req.query('bookId');
  const stmt = bookId
    ? c.env.DB.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND book_id = ? ORDER BY created_at DESC').bind(user.id, bookId)
    : c.env.DB.prepare('SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC').bind(user.id);
  const { results } = await stmt.all();
  return c.json({ bookmarks: results });
});

bookmarks.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req
    .json<{ bookId?: string; chapterId?: string; blockId?: string; charOffset?: number; note?: string }>()
    .catch(() => null);
  if (!body?.bookId || !body.chapterId || !body.blockId) return c.json({ error: 'bad_request' }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO bookmarks (id, user_id, book_id, chapter_id, block_id, char_offset, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, user.id, body.bookId, body.chapterId, body.blockId, Math.max(0, Number(body.charOffset) || 0), body.note ?? null, Date.now())
    .run();
  return c.json({ id }, 201);
});

bookmarks.delete('/:id', async (c) => {
  const user = c.get('user');
  await c.env.DB.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').bind(c.req.param('id'), user.id).run();
  return c.json({ ok: true });
});
