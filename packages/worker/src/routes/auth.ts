import { Hono } from 'hono';
import type { AppContext } from '../types';
import { randomToken, sha256Hex, signState, verifyState, b64url } from '../lib/crypto';
import { createSession, destroySession, loadUser, upsertUserByEmail } from '../lib/session';
import { sendMail, magicLinkEmail, passwordResetEmail } from '../lib/resend';
import { hashPassword, verifyPassword, dummyVerify } from '../lib/password';
import { rateLimit } from '../lib/ratelimit';

/** Caller's IP, namespaced per endpoint so one bucket's limit never bleeds into another's. */
function ipBucket(c: { req: { header(name: string): string | undefined } }, prefix: string): string {
  return `${prefix}:${c.req.header('cf-connecting-ip') ?? 'ip?'}`;
}

export const auth = new Hono<AppContext>();

// ---- Email + username + password (primary sign-in surface) ----
//
// Simple, dead-quick account creation: email, a username you can also sign in
// with, and a password. No ceremony, no email round-trip to finish signing
// in. Magic link/code and passkeys (below) stay fully functional at the API
// level; this is just the one the app's sign-in screen shows.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;

auth.post('/register', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  if (!(await rateLimit(c.env.DB, ipBucket(c, 'register'), 5, 15 * 60 * 1000))) return c.json({ error: 'rate_limited' }, 429);
  const body = await c.req
    .json<{ email?: string; username?: string; password?: string }>()
    .catch(() => ({}) as { email?: string; username?: string; password?: string });
  const email = (body.email ?? '').trim().toLowerCase();
  const username = (body.username ?? '').trim();
  const password = body.password ?? '';

  if (!EMAIL_RE.test(email)) return c.json({ error: 'invalid_email' }, 400);
  if (!USERNAME_RE.test(username)) return c.json({ error: 'invalid_username' }, 400);
  if (password.length < 8) return c.json({ error: 'invalid_password' }, 400);

  const existingUsername = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string }>();
  if (existingUsername) return c.json({ error: 'username_taken' }, 409);

  const existingEmail = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; password_hash: string | null }>();
  if (existingEmail?.password_hash) return c.json({ error: 'email_taken' }, 409);

  const { hash, salt, iterations } = await hashPassword(password);
  const now = Date.now();
  let userId: string;

  try {
    if (existingEmail) {
      // A passwordless account (magic-link/Google/passkey-only) already owns
      // this email; attach the username + password to it as a second door,
      // same user, same id, rather than erroring.
      userId = existingEmail.id;
      await c.env.DB.prepare(
        'UPDATE users SET username = ?, password_hash = ?, password_salt = ?, password_iterations = ?, last_seen_at = ? WHERE id = ?'
      )
        .bind(username, hash, salt, iterations, now, userId)
        .run();
    } else {
      userId = crypto.randomUUID();
      await c.env.DB.prepare(
        'INSERT INTO users (id, email, username, password_hash, password_salt, password_iterations, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(userId, email, username, hash, salt, iterations, now, now)
        .run();
    }
  } catch (err) {
    // Closes the race window between the pre-checks above and this write:
    // two near-simultaneous registrations for the same username or email
    // both pass the SELECT, then one of the writes below hits the unique
    // index/constraint instead of silently succeeding.
    const msg = err instanceof Error ? err.message : '';
    if (/UNIQUE constraint failed:\s*users\.username/i.test(msg)) return c.json({ error: 'username_taken' }, 409);
    if (/UNIQUE constraint failed:\s*users\.email/i.test(msg)) return c.json({ error: 'email_taken' }, 409);
    throw err;
  }

  const urow = await c.env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
    .bind(userId)
    .first<{ display_name: string | null }>();
  await createSession(c, userId);
  return c.json({ ok: true, user: { id: userId, email, username, displayName: urow?.display_name ?? null } }, 201);
});

auth.post('/login', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  if (!(await rateLimit(c.env.DB, ipBucket(c, 'login'), 10, 10 * 60 * 1000))) return c.json({ error: 'rate_limited' }, 429);
  const body = await c.req
    .json<{ identifier?: string; password?: string }>()
    .catch(() => ({}) as { identifier?: string; password?: string });
  const identifier = (body.identifier ?? '').trim();
  const password = body.password ?? '';

  // One error shape for every failure mode below (bad input, unknown
  // identifier, account with no password set, wrong password): the caller
  // never learns which, and a dummy PBKDF2 derive keeps "no such account"
  // and "wrong password" taking about the same amount of time.
  if (!identifier || !password) {
    await dummyVerify(password || identifier || 'placeholder');
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  const row = await c.env.DB.prepare(
    `SELECT id, email, username, display_name, password_hash, password_salt, password_iterations
     FROM users WHERE email = ? OR username = ?`
  )
    .bind(identifier, identifier)
    .first<{
      id: string;
      email: string;
      username: string | null;
      display_name: string | null;
      password_hash: string | null;
      password_salt: string | null;
      password_iterations: number | null;
    }>();

  if (!row || !row.password_hash || !row.password_salt || !row.password_iterations) {
    await dummyVerify(password);
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  const ok = await verifyPassword(password, {
    hash: row.password_hash,
    salt: row.password_salt,
    iterations: row.password_iterations,
  });
  if (!ok) return c.json({ error: 'invalid_credentials' }, 401);

  await c.env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  await createSession(c, row.id);
  return c.json({
    ok: true,
    user: { id: row.id, email: row.email, username: row.username, displayName: row.display_name },
  });
});

// ---- Password recovery (forgot / reset) ----
//
// Same "emailed link token + typed 6-digit code" shape as magic sign-in, but
// in its own password_resets table (0004), keyed to a user id, 30-minute
// single-use tokens hashed at rest. /forgot always answers 200 so it can't be
// used to probe which emails have accounts; /reset takes EITHER the link token
// OR email+code, sets the new password, burns every outstanding reset for that
// user, and signs them in on this response.

const RESET_TTL_MS = 30 * 60 * 1000;

auth.post('/password/forgot', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  if (!(await rateLimit(c.env.DB, ipBucket(c, 'forgot'), 5, 15 * 60 * 1000))) return c.json({ error: 'rate_limited' }, 429);
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = (body.email ?? '').trim().toLowerCase();
  // Always 200: never reveal whether this email has an account.
  if (!EMAIL_RE.test(email)) return c.json({ ok: true });

  const user = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; password_hash: string | null }>();
  // Only accounts that actually have a password can reset one. Passwordless
  // accounts (magic-link/Google/passkey only) get the same silent 200; there
  // is nothing to reset and their existing door still works.
  if (!user?.password_hash) return c.json({ ok: true });

  const now = Date.now();
  // Cap outstanding resets so /forgot can't be turned into an inbox flooder.
  // Each request writes 2 rows (token + code), so 4 == two live requests.
  const { count } = (await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM password_resets WHERE user_id = ? AND expires_at > ? AND used_at IS NULL'
  )
    .bind(user.id, now)
    .first<{ count: number }>()) ?? { count: 0 };
  if (count >= 4) return c.json({ ok: true });

  const expiresAt = now + RESET_TTL_MS;

  const token = randomToken(32);
  await c.env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), user.id, expiresAt)
    .run();

  const code = sixDigitCode();
  await c.env.DB.insertIgnore(
    'password_resets',
    ['token_hash', 'user_id', 'expires_at'],
    [await resetCodeHash(user.id, code), user.id, expiresAt],
    ['token_hash']
  );

  const link = `${c.env.APP_ORIGIN}/settings?reset=${token}`;
  c.executionCtx.waitUntil(
    sendMail(
      c.env.RESEND_API_KEY,
      c.env.MAIL_FROM,
      email,
      `Reset your ${c.env.APP_NAME} password`,
      passwordResetEmail(c.env.APP_NAME, link, code)
    )
  );
  return c.json({ ok: true });
});

auth.post('/password/reset', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  const body = await c.req
    .json<{ token?: string; email?: string; code?: string; password?: string }>()
    .catch(() => ({}) as { token?: string; email?: string; code?: string; password?: string });
  const password = body.password ?? '';
  if (password.length < 8) return c.json({ error: 'invalid_password' }, 400);

  const now = Date.now();
  let userId: string | null = null;

  const token = (body.token ?? '').trim();
  if (token) {
    const row = await c.env.DB.prepare(
      'SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
    )
      .bind(await sha256Hex(token), now)
      .first<{ user_id: string }>();
    userId = row?.user_id ?? null;
  } else {
    const email = (body.email ?? '').trim().toLowerCase();
    const code = (body.code ?? '').trim();
    if (EMAIL_RE.test(email) && /^\d{6}$/.test(code)) {
      const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
        .bind(email)
        .first<{ id: string }>();
      if (user) {
        const row = await c.env.DB.prepare(
          'SELECT user_id FROM password_resets WHERE token_hash = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?'
        )
          .bind(await resetCodeHash(user.id, code), user.id, now)
          .first<{ user_id: string }>();
        userId = row?.user_id ?? null;
      }
    }
  }

  // One generic failure for a bad/expired/used token or code; never say which.
  if (!userId) return c.json({ error: 'invalid_or_expired' }, 400);

  const { hash, salt, iterations } = await hashPassword(password);
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, last_seen_at = ? WHERE id = ?'
  )
    .bind(hash, salt, iterations, now, userId)
    .run();
  // Burn every outstanding reset for this user (the link just used and its
  // sibling code, plus any earlier still-valid request) so none can be replayed.
  await c.env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .bind(now, userId)
    .run();

  const urow = await c.env.DB.prepare('SELECT email, username, display_name FROM users WHERE id = ?')
    .bind(userId)
    .first<{ email: string; username: string | null; display_name: string | null }>();
  await createSession(c, userId);
  return c.json({
    ok: true,
    user: { id: userId, email: urow?.email ?? '', username: urow?.username ?? null, displayName: urow?.display_name ?? null },
  });
});

// ---- Magic link ----

auth.post('/magic/request', async (c) => {
  if (!(await rateLimit(c.env.DB, ipBucket(c, 'magic'), 5, 15 * 60 * 1000))) return c.json({ error: 'rate_limited' }, 429);
  const body = await c.req.json<{ email?: string }>().catch(() => ({} as { email?: string }));
  const email = (body.email ?? '').trim().toLowerCase();
  // Always answer 200 so the endpoint can't be used to enumerate accounts.
  if (!EMAIL_RE.test(email)) return c.json({ ok: true });

  const now = Date.now();
  const { count } = (await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM magic_links WHERE email = ? AND expires_at > ? AND used_at IS NULL'
  )
    .bind(email, now)
    .first<{ count: number }>()) ?? { count: 0 };
  if (count >= 3) return c.json({ ok: true });

  const expiresAt = now + 15 * 60 * 1000;

  const token = randomToken(32);
  await c.env.DB.prepare('INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), email, expiresAt)
    .run();

  // Second credential, same table: a 6-digit code the user can type INSIDE the
  // app (fetch → Set-Cookie in the same browser context). The hash is namespaced
  // by email so codes never collide on the token_hash primary key and one email's
  // code can't be verified against another's. insertIgnore tolerates the
  // (1-in-a-million) case of regenerating an identical outstanding code.
  const code = sixDigitCode();
  await c.env.DB.insertIgnore(
    'magic_links',
    ['token_hash', 'email', 'expires_at'],
    [await codeHash(email, code), email, expiresAt],
    ['token_hash']
  );

  const link = `${c.env.APP_ORIGIN}/api/auth/magic/verify?token=${token}`;
  c.executionCtx.waitUntil(
    sendMail(c.env.RESEND_API_KEY, c.env.MAIL_FROM, email, `Sign in to ${c.env.APP_NAME}`, magicLinkEmail(c.env.APP_NAME, link, code))
  );
  return c.json({ ok: true });
});

// Verify a 6-digit code from inside the app. Unauthenticated (no session yet),
// so it can't use requireAuth — but it still demands the CSRF header and sets
// the session cookie on THIS response, landing it in the caller's context.
auth.post('/code/verify', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  const body = await c.req.json<{ email?: string; code?: string }>().catch(() => ({}) as { email?: string; code?: string });
  const email = (body.email ?? '').trim().toLowerCase();
  const code = (body.code ?? '').trim();
  // One generic 400 for malformed input; never reveal whether the email or the code was at fault.
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) {
    return c.json({ error: 'invalid_code' }, 400);
  }
  const hash = await codeHash(email, code);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    'SELECT email FROM magic_links WHERE token_hash = ? AND email = ? AND used_at IS NULL AND expires_at > ?'
  )
    .bind(hash, email, now)
    .first<{ email: string }>();
  if (!row) return c.json({ error: 'invalid_code' }, 401);
  await c.env.DB.prepare('UPDATE magic_links SET used_at = ? WHERE token_hash = ?').bind(now, hash).run();
  const userId = await upsertUserByEmail(c.env.DB, row.email);
  await createSession(c, userId);
  const urow = await c.env.DB.prepare('SELECT display_name, username FROM users WHERE id = ?')
    .bind(userId)
    .first<{ display_name: string | null; username: string | null }>();
  return c.json({
    ok: true,
    user: { id: userId, email: row.email, username: urow?.username ?? null, displayName: urow?.display_name ?? null },
  });
});

auth.get('/magic/verify', async (c) => {
  const token = c.req.query('token') ?? '';
  const hash = await sha256Hex(token);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    'SELECT email FROM magic_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
  )
    .bind(hash, now)
    .first<{ email: string }>();
  if (!row) return c.redirect('/?auth=expired');
  await c.env.DB.prepare('UPDATE magic_links SET used_at = ? WHERE token_hash = ?').bind(now, hash).run();
  const userId = await upsertUserByEmail(c.env.DB, row.email);
  await createSession(c, userId);
  return c.redirect('/?auth=ok');
});

// ---- Google OAuth (code flow + PKCE, server-side exchange) ----

auth.get('/google', async (c) => {
  const verifier = randomToken(32);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = await signState({ v: verifier }, c.env.ADMIN_KEY);
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${c.env.APP_ORIGIN}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

auth.get('/google/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state') ?? '';
  const parsed = await verifyState(state, c.env.ADMIN_KEY);
  if (!code || !parsed?.v) return c.redirect('/?auth=failed');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: parsed.v,
      grant_type: 'authorization_code',
      redirect_uri: `${c.env.APP_ORIGIN}/api/auth/google/callback`,
    }),
  });
  if (!tokenRes.ok) return c.redirect('/?auth=failed');
  const tokens = await tokenRes.json<{ id_token?: string }>();
  const claims = decodeIdToken(tokens.id_token ?? '');
  // The id_token came directly from Google over TLS, so its claims are trustworthy here.
  if (!claims || claims.aud !== c.env.GOOGLE_CLIENT_ID || !claims.email || claims.email_verified === false) {
    return c.redirect('/?auth=failed');
  }

  const existing = await c.env.DB.prepare(
    'SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?'
  )
    .bind('google', claims.sub)
    .first<{ user_id: string }>();

  let userId: string;
  if (existing) {
    userId = existing.user_id;
    await c.env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(Date.now(), userId).run();
  } else {
    userId = await upsertUserByEmail(c.env.DB, claims.email.toLowerCase());
    await c.env.DB.insertIgnore(
      'oauth_identities',
      ['provider', 'provider_user_id', 'user_id'],
      ['google', claims.sub, userId],
      ['provider', 'provider_user_id']
    );
    if (claims.name) {
      await c.env.DB.prepare('UPDATE users SET display_name = COALESCE(display_name, ?) WHERE id = ?')
        .bind(claims.name, userId)
        .run();
    }
  }
  await createSession(c, userId);
  return c.redirect('/?auth=ok');
});

auth.post('/logout', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  await destroySession(c);
  return c.json({ ok: true });
});

auth.get('/me', async (c) => {
  const user = await loadUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  // isAdmin (AB#7404) is what the /admin screen keys off to decide between
  // the dashboard and a "this account isn't an operator" message — it's a
  // display hint only; every admin route re-checks the flag server-side.
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.display_name,
      isAdmin: Boolean(user.is_admin),
    },
  });
});

/** Cryptographically-random 6-digit code, zero-padded (000000–999999). */
function sixDigitCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, '0');
}

/** Email-namespaced hash of a sign-in code, stored in magic_links.token_hash. */
function codeHash(email: string, code: string): Promise<string> {
  return sha256Hex(`code:${email}\n${code}`);
}

/** User-id-namespaced hash of a reset code, stored in password_resets.token_hash. */
function resetCodeHash(userId: string, code: string): Promise<string> {
  return sha256Hex(`reset:${userId}\n${code}`);
}

function decodeIdToken(
  idToken: string
): { sub: string; aud: string; email?: string; email_verified?: boolean; name?: string } | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const pad = parts[1].length % 4 === 0 ? '' : '='.repeat(4 - (parts[1].length % 4));
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad));
  } catch {
    return null;
  }
}
