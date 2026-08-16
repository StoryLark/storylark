import { Hono } from 'hono';
import type { AppContext } from '../types';
import { randomToken, sha256Hex } from '../lib/crypto';
import { createSession } from '../lib/session';
import { hashPassword } from '../lib/password';
import { rateLimit } from '../lib/ratelimit';

/**
 * Admin account bootstrap and recovery (AB#7404).
 *
 * The admin portal is gated by a normal account in the `users` table with
 * `is_admin = 1` — same email+password, same session cookie, same emailed
 * password reset as any reader. That leaves exactly one question this file
 * answers: how does the FIRST admin account come to exist, and how does an
 * operator get back in when they've forgotten the password?
 *
 * Three doors, deliberately:
 *
 *   1. Emailed password reset — POST /api/auth/password/forgot + /reset in
 *      routes/auth.ts. Needs no code here at all: it works for any user row
 *      that has a password, and an admin is just such a row. Requires that
 *      the deployment has RESEND_API_KEY + MAIL_FROM configured and that the
 *      operator can read that mailbox.
 *
 *   2. A one-time recovery code — POST /recover below. Codes are printed by
 *      the installer at deploy time and never shown again, so this door has
 *      zero runtime dependencies (no mail provider, no CLI, no cloud
 *      console) and works identically on every platform.
 *
 *   3. A fresh setup link — POST /setup/reset below, gated by the ADMIN_KEY
 *      deployment secret. Last resort, for when both the password and the
 *      recovery codes are gone. Safe by construction: anyone who can read or
 *      change ADMIN_KEY (Azure portal, `wrangler secret put`) can already
 *      redeploy the entire application, so this grants no power they didn't
 *      have. It is no longer the day-to-day door — that was the model the
 *      product owner rejected.
 *
 * Everything here follows routes/auth.ts's existing conventions: CSRF header
 * on mutating requests that come from the app, IP-bucketed rate limiting on
 * every unauthenticated endpoint, credentials hashed at rest and single-use,
 * and one generic error for every failure mode so nothing here can be used
 * to probe which emails or codes exist.
 */
export const adminAuth = new Hono<AppContext>();

/** Caller's IP, namespaced per endpoint — same helper shape as routes/auth.ts. */
function ipBucket(c: { req: { header(name: string): string | undefined } }, prefix: string): string {
  return `${prefix}:${c.req.header('cf-connecting-ip') ?? 'ip?'}`;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;

/**
 * Setup links are meant to be used within minutes of the installer printing
 * one, so 60 minutes is already generous. It's short on purpose: the link
 * grants the right to CREATE an operator account, so an unnoticed one left
 * live in terminal scrollback or a CI log should stop working the same
 * afternoon. If it lapses, minting another is one command (see /setup/reset).
 */
const SETUP_TTL_MS = 60 * 60 * 1000;

/** How many recovery codes a mint produces. Matches the industry norm (GitHub/Google 2FA backup codes). */
const RECOVERY_CODE_COUNT = 10;

/**
 * Recovery-code alphabet: uppercase letters + digits, minus the pairs that
 * get misread off a printed page or a terminal (0/O, 1/I/L, 5/S, 8/B). 28
 * symbols over 12 characters is ~57 bits — far past guessable, and still
 * three short groups a person can type back in without swearing.
 */
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXYZ2346789';
const CODE_CHARS = 12;

function generateRecoveryCode(): string {
  const bytes = new Uint8Array(CODE_CHARS);
  crypto.getRandomValues(bytes);
  // Rejection-free modulo bias is irrelevant at 256 % 28: the worst-case
  // skew is under 0.5 bits across 12 characters and these are one-time
  // codes behind a rate limit, not key material.
  let out = '';
  for (let i = 0; i < CODE_CHARS; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/**
 * Codes are compared in canonical form — uppercased, every non-alphanumeric
 * stripped — so it doesn't matter whether the operator retyped the dashes,
 * pasted with a trailing space, or shouted it in lowercase.
 */
function canonicalCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Namespaced hashes, so a value from one table can never validate against the other. */
const setupTokenHash = (token: string): Promise<string> => sha256Hex(`admin-setup:${token}`);
const recoveryCodeHash = (code: string): Promise<string> => sha256Hex(`admin-recovery:${canonicalCode(code)}`);

function hasAdminKey(c: { req: { header(name: string): string | undefined }; env: { ADMIN_KEY: string } }): boolean {
  return !!c.env.ADMIN_KEY && c.req.header('x-admin-key') === c.env.ADMIN_KEY;
}

/**
 * Mint a setup link + a fresh batch of recovery codes. Called by the
 * installer at the end of a successful deploy (the Cloudflare and Azure
 * install.mjs scripts under platforms/), and by hand afterwards if the
 * operator ever locks themselves out
 * completely.
 *
 * Gated by ADMIN_KEY, exactly like POST /api/admin/setup — both are
 * "deployment configuration access" operations that must work before any
 * user or session can possibly exist.
 *
 * The plaintext token and codes exist ONLY in this response. Nothing but
 * their hashes is stored, so this is genuinely the last moment anyone can
 * read them — the caller prints them and they're gone.
 */
adminAuth.post('/setup/reset', async (c) => {
  // Rate limited despite the key check, so the key itself can't be brute
  // forced against this endpoint any faster than 10 tries a quarter hour.
  if (!(await rateLimit(c.env.DB, ipBucket(c, 'admin-setup-reset'), 10, 15 * 60 * 1000))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  if (!hasAdminKey(c)) return c.json({ error: 'unauthorized' }, 401);

  const now = Date.now();

  // Burn everything still outstanding first. Re-running this must not leave
  // an older setup link or an older printed sheet of codes quietly valid —
  // the batch the operator is about to save is the only one that works.
  await c.env.DB.prepare('UPDATE admin_setup_tokens SET used_at = ? WHERE used_at IS NULL').bind(now).run();
  await c.env.DB.prepare('UPDATE admin_recovery_codes SET used_at = ? WHERE used_at IS NULL').bind(now).run();

  const token = randomToken(32);
  await c.env.DB.prepare(
    'INSERT INTO admin_setup_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)'
  )
    .bind(await setupTokenHash(token), now, now + SETUP_TTL_MS)
    .run();

  const recoveryCodes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = generateRecoveryCode();
    recoveryCodes.push(code);
    // insertIgnore rather than insert: a collision across 10 draws from a
    // ~57-bit space is vanishingly unlikely, but a duplicate primary key
    // should degrade to "nine codes" rather than a 500 mid-install.
    await c.env.DB.insertIgnore(
      'admin_recovery_codes',
      ['code_hash', 'created_at'],
      [await recoveryCodeHash(code), now],
      ['code_hash']
    );
  }

  return c.json({
    ok: true,
    setupUrl: `${c.env.APP_ORIGIN}/admin?setup=${token}`,
    expiresAt: now + SETUP_TTL_MS,
    recoveryCodes,
  });
});

/**
 * Claim a setup link: create (or promote) the admin account and sign in.
 *
 * Unauthenticated by definition — the token IS the credential — so it can't
 * use requireAuth/requireAdmin, but it still demands the CSRF header (the
 * request comes from the admin screen in a browser, same as
 * /api/auth/code/verify) and it's rate limited like every other
 * unauthenticated auth endpoint. The session cookie is set on THIS response,
 * so the operator lands straight in the dashboard.
 */
adminAuth.post('/setup/claim', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  if (!(await rateLimit(c.env.DB, ipBucket(c, 'admin-setup-claim'), 10, 15 * 60 * 1000))) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const body = await c.req
    .json<{ token?: string; email?: string; username?: string; password?: string }>()
    .catch(() => ({}) as { token?: string; email?: string; username?: string; password?: string });
  const token = (body.token ?? '').trim();
  const email = (body.email ?? '').trim().toLowerCase();
  const username = (body.username ?? '').trim();
  const password = body.password ?? '';

  if (!EMAIL_RE.test(email)) return c.json({ error: 'invalid_email' }, 400);
  if (username && !USERNAME_RE.test(username)) return c.json({ error: 'invalid_username' }, 400);
  if (password.length < 8) return c.json({ error: 'invalid_password' }, 400);

  const now = Date.now();
  const tokenHash = await setupTokenHash(token);
  const row = token
    ? await c.env.DB.prepare(
        'SELECT token_hash FROM admin_setup_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
      )
        .bind(tokenHash, now)
        .first<{ token_hash: string }>()
    : null;
  // One generic failure for missing/wrong/expired/already-used; never say which.
  if (!row) return c.json({ error: 'invalid_or_expired' }, 400);

  const { hash, salt, iterations } = await hashPassword(password);

  // Same create-or-attach shape as /api/auth/register: if this email already
  // has an account (an operator who reads on the same site, say), promote
  // that row rather than colliding with the unique email index.
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  let userId: string;
  try {
    if (existing) {
      userId = existing.id;
      await c.env.DB.prepare(
        `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, is_admin = 1, last_seen_at = ?
         WHERE id = ?`
      )
        .bind(hash, salt, iterations, now, userId)
        .run();
      // Separate statement rather than a COALESCE(?, username) in the one
      // above: Postgres can't infer the type of a bare NULL parameter inside
      // COALESCE against a citext column, and this stays legible anyway.
      if (username) {
        await c.env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(username, userId).run();
      }
    } else {
      userId = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, username, password_hash, password_salt, password_iterations, is_admin, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
        .bind(userId, email, username || null, hash, salt, iterations, now, now)
        .run();
    }
  } catch (err) {
    // Mirrors /register: the pre-check above races with the unique index.
    const msg = err instanceof Error ? err.message : '';
    if (/unique constraint.*users[._]username/i.test(msg)) return c.json({ error: 'username_taken' }, 409);
    if (/unique constraint.*users[._]email/i.test(msg)) return c.json({ error: 'email_taken' }, 409);
    throw err;
  }

  // Burn the token only now that the account actually exists, so a failed
  // claim (taken username, database hiccup) doesn't strand the operator with
  // a spent link and no account.
  await c.env.DB.prepare('UPDATE admin_setup_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
    .bind(now, tokenHash)
    .run();

  const urow = await c.env.DB.prepare('SELECT username, display_name FROM users WHERE id = ?')
    .bind(userId)
    .first<{ username: string | null; display_name: string | null }>();
  await createSession(c, userId);
  return c.json({
    ok: true,
    user: { id: userId, email, username: urow?.username ?? null, displayName: urow?.display_name ?? null, isAdmin: true },
  });
});

/**
 * Door 2: sign in with one of the recovery codes printed at install time,
 * setting a new password in the same step.
 *
 * Deliberately separate from /api/auth/password/reset rather than folded
 * into it: that flow's credential is something the server just emailed or
 * the user just requested, and it lives in password_resets. This one's
 * credential predates the lockout by months, isn't tied to a user id, and
 * must keep working when mail delivery doesn't. Sharing a route would mean
 * one endpoint with two very different trust stories.
 *
 * `email` says WHICH admin account to reset — deployments can have more than
 * one operator, and the codes are deployment-wide.
 */
adminAuth.post('/recover', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  // Tighter than the other buckets: this is the one endpoint where a guessed
  // credential hands over an operator account, so 5 tries per quarter hour.
  if (!(await rateLimit(c.env.DB, ipBucket(c, 'admin-recover'), 5, 15 * 60 * 1000))) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const body = await c.req
    .json<{ code?: string; email?: string; password?: string }>()
    .catch(() => ({}) as { code?: string; email?: string; password?: string });
  const code = (body.code ?? '').trim();
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';

  if (password.length < 8) return c.json({ error: 'invalid_password' }, 400);

  const now = Date.now();
  const codeHash = await recoveryCodeHash(code);

  // Both lookups feed ONE generic failure below — a wrong code, an unknown
  // email, and a real-but-non-admin account are indistinguishable from here.
  const codeRow = canonicalCode(code)
    ? await c.env.DB.prepare('SELECT code_hash FROM admin_recovery_codes WHERE code_hash = ? AND used_at IS NULL')
        .bind(codeHash)
        .first<{ code_hash: string }>()
    : null;
  const user = EMAIL_RE.test(email)
    ? await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND is_admin = 1').bind(email).first<{ id: string }>()
    : null;

  if (!codeRow || !user) return c.json({ error: 'invalid_or_expired' }, 400);

  const { hash, salt, iterations } = await hashPassword(password);
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, last_seen_at = ? WHERE id = ?'
  )
    .bind(hash, salt, iterations, now, user.id)
    .run();

  // Burn the code only on full success. A code spent on a request that then
  // failed would be a code the operator no longer has — and they may only
  // have a handful left.
  await c.env.DB.prepare('UPDATE admin_recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
    .bind(now, codeHash)
    .run();
  // A password reset makes any outstanding emailed reset stale, same as
  // /api/auth/password/reset does for its own table.
  await c.env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .bind(now, user.id)
    .run();

  const { count: remaining } = (await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM admin_recovery_codes WHERE used_at IS NULL'
  ).first<{ count: number }>()) ?? { count: 0 };

  const urow = await c.env.DB.prepare('SELECT username, display_name FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ username: string | null; display_name: string | null }>();
  await createSession(c, user.id);
  return c.json({
    ok: true,
    // So the portal can nudge "2 codes left — mint a fresh batch" before the
    // operator burns the last one and loses this door entirely.
    recoveryCodesRemaining: Number(remaining) || 0,
    user: { id: user.id, email, username: urow?.username ?? null, displayName: urow?.display_name ?? null, isAdmin: true },
  });
});
