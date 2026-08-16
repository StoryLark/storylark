import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppContext, SessionRow, User } from '../types';
import type { Database } from '../db/types';
import { randomToken, sha256Hex } from './crypto';

const COOKIE = 'sr_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const REFRESH_BELOW_MS = 15 * 24 * 3600 * 1000;

export async function createSession(c: Context<AppContext>, userId: string): Promise<void> {
  const raw = randomToken(32);
  const id = await sha256Hex(raw);
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, userId, now, now + SESSION_MS, c.req.header('user-agent') ?? null)
    .run();
  setCookie(c, COOKIE, raw, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MS / 1000,
  });
}

export async function destroySession(c: Context<AppContext>): Promise<void> {
  const raw = getCookie(c, COOKIE);
  if (raw) {
    const id = await sha256Hex(raw);
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
  }
  deleteCookie(c, COOKIE, { path: '/' });
}

/** Loads the session user, refreshing the rolling expiry when under 15 days remain. */
export async function loadUser(c: Context<AppContext>): Promise<User | null> {
  const raw = getCookie(c, COOKIE);
  if (!raw) return null;
  const id = await sha256Hex(raw);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.id as sid, s.expires_at, u.id, u.email, u.username, u.display_name, u.created_at, u.last_seen_at, u.is_admin
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`
  )
    .bind(id, now)
    .first<SessionRow & User & { sid: string }>();
  if (!row) return null;
  if (row.expires_at - now < REFRESH_BELOW_MS) {
    await c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(now + SESSION_MS, id).run();
    setCookie(c, COOKIE, raw, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_MS / 1000,
    });
  }
  c.set('sessionId', id);
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    display_name: row.display_name,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    // Normalised to 0/1 here so every caller downstream sees a number,
    // whatever the driver handed back for the INTEGER column.
    is_admin: row.is_admin ? 1 : 0,
  };
}

/** Middleware: require a signed-in user; also enforces the CSRF header on mutating requests. */
export function requireAuth() {
  return async (c: Context<AppContext>, next: Next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (c.req.header('x-requested-with') !== 'storylark') {
        return c.json({ error: 'missing_csrf_header' }, 403);
      }
    }
    const user = await loadUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    await next();
  };
}

/**
 * Middleware: require a signed-in user whose account carries the operator
 * flag (AB#7404). Same shape and same CSRF rule as requireAuth() — this is
 * deliberately NOT a stronger kind of authentication, just a different
 * predicate on the same session. The job is to keep non-operators from
 * editing content or triggering platform updates; the content itself is
 * public either way.
 *
 * 401 vs 403 is meaningful to the admin UI: 401 means "sign in", 403 means
 * "you're signed in, but this account isn't an operator" — the portal shows
 * different screens for each rather than a blank page.
 */
export function requireAdmin() {
  return async (c: Context<AppContext>, next: Next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (c.req.header('x-requested-with') !== 'storylark') {
        return c.json({ error: 'missing_csrf_header' }, 403);
      }
    }
    const user = await loadUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    if (!user.is_admin) return c.json({ error: 'forbidden' }, 403);
    c.set('user', user);
    await next();
  };
}

export async function upsertUserByEmail(db: Database, email: string): Promise<string> {
  const now = Date.now();
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  if (existing) {
    await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, existing.id).run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .bind(id, email, now, now)
    .run();
  return id;
}
