import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppContext } from '../types';
import { loadUser } from '../lib/session';

export const push = new Hono<AppContext>();

// The marketing site's installed PWA can subscribe cross-origin (the brand's
// marketing domain → its app subdomain). Set the allowed origin(s) to the
// brand's marketing site; app-origin requests are same-origin and need no CORS.
push.use(
  '*',
  cors({
    origin: ['https://storylark.dev', 'https://www.storylark.dev'],
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'x-requested-with'],
  })
);

push.post('/subscribe', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  const body = await c.req.json<{ endpoint?: string; p256dh?: string; auth?: string }>().catch(() => null);
  if (!body?.endpoint || !body.p256dh || !body.auth) return c.json({ error: 'bad_request' }, 400);
  const user = await loadUser(c); // optional — anonymous subscriptions allowed
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at, failed_count)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failed_count = 0`
  )
    .bind(body.endpoint, user?.id ?? null, body.p256dh, body.auth, Date.now())
    .run();
  return c.json({ ok: true });
});

push.post('/unsubscribe', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  const body = await c.req.json<{ endpoint?: string }>().catch(() => null);
  if (!body?.endpoint) return c.json({ error: 'bad_request' }, 400);
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(body.endpoint).run();
  return c.json({ ok: true });
});
