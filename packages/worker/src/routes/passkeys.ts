import { Hono } from 'hono';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import type { AppContext } from '../types';
import { requireAuth, createSession } from '../lib/session';
import { b64url } from '../lib/crypto';
import {
  getRpConfig,
  storeChallenge,
  consumeChallenge,
  toWebAuthnCredential,
  labelFromUserAgent,
  freshUint8Array,
  type PasskeyRow,
} from '../lib/webauthn';

export const passkeys = new Hono<AppContext>();

// ---- Registration: attach a new passkey to the CURRENT signed-in user. ----
// Deliberately auth-gated — passkey registration doesn't itself prove email
// ownership, so it only ever attaches to an account that already got there
// some other way (email code today; Google tomorrow). requireAuth() also
// enforces the CSRF header on both of these (POST).

passkeys.post('/register-options', requireAuth(), async (c) => {
  const user = c.get('user');
  const { rpID, rpName } = getRpConfig(c);

  const existing = await c.env.DB.prepare('SELECT credential_id, transports FROM passkey_credentials WHERE user_id = ?')
    .bind(user.id)
    .all<{ credential_id: string; transports: string | null }>();

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: freshUint8Array(new TextEncoder().encode(user.id)),
    userName: user.email,
    userDisplayName: user.display_name ?? user.email,
    attestationType: 'none',
    excludeCredentials: existing.results.map((r) => ({
      id: r.credential_id,
      transports: r.transports ? JSON.parse(r.transports) : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
  });

  const challengeId = await storeChallenge(c.env.DB, options.challenge, 'register', user.id);
  return c.json({ options, challengeId });
});

passkeys.post('/register-verify', requireAuth(), async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ challengeId?: string; response?: RegistrationResponseJSON }>().catch(
    () => ({}) as { challengeId?: string; response?: RegistrationResponseJSON }
  );
  if (!body.challengeId || !body.response) return c.json({ error: 'bad_request' }, 400);

  const consumed = await consumeChallenge(c.env.DB, body.challengeId, 'register');
  if (!consumed || consumed.userId !== user.id) return c.json({ error: 'challenge_expired' }, 400);

  const { rpID, origin } = getRpConfig(c);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: consumed.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch {
    return c.json({ error: 'verification_failed' }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) return c.json({ error: 'verification_failed' }, 400);

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO passkey_credentials
       (credential_id, user_id, public_key, counter, transports, device_type, backed_up, label, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      credential.id,
      user.id,
      b64url(credential.publicKey),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      labelFromUserAgent(c.req.header('user-agent') ?? null),
      now,
      now
    )
    .run();

  return c.json({ ok: true });
});

// ---- Login: usernameless (discoverable-credential) sign-in. Unauthenticated
// by definition — this IS how a session gets created, same as /code/verify. ----

passkeys.post('/login-options', async (c) => {
  const { rpID } = getRpConfig(c);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    // No allowCredentials: the platform shows whichever passkeys it holds for
    // this rpID, so sign-in needs no email/username step first.
  });
  const challengeId = await storeChallenge(c.env.DB, options.challenge, 'login', null);
  return c.json({ options, challengeId });
});

passkeys.post('/login-verify', async (c) => {
  if (c.req.header('x-requested-with') !== 'storylark') return c.json({ error: 'missing_csrf_header' }, 403);
  const body = await c.req.json<{ challengeId?: string; response?: AuthenticationResponseJSON }>().catch(
    () => ({}) as { challengeId?: string; response?: AuthenticationResponseJSON }
  );
  if (!body.challengeId || !body.response) return c.json({ error: 'bad_request' }, 400);

  const consumed = await consumeChallenge(c.env.DB, body.challengeId, 'login');
  if (!consumed) return c.json({ error: 'challenge_expired' }, 400);

  const credentialId = body.response.id;
  const row = await c.env.DB.prepare('SELECT * FROM passkey_credentials WHERE credential_id = ?')
    .bind(credentialId)
    .first<PasskeyRow>();
  if (!row) return c.json({ error: 'unknown_passkey' }, 400);

  const { rpID, origin } = getRpConfig(c);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: consumed.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: toWebAuthnCredential(row),
    });
  } catch {
    return c.json({ error: 'verification_failed' }, 400);
  }
  if (!verification.verified) return c.json({ error: 'verification_failed' }, 400);

  const now = Date.now();
  await c.env.DB.prepare('UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?')
    .bind(verification.authenticationInfo.newCounter, now, credentialId)
    .run();
  await c.env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, row.user_id).run();

  await createSession(c, row.user_id);
  const u = await c.env.DB.prepare('SELECT email, username, display_name FROM users WHERE id = ?')
    .bind(row.user_id)
    .first<{ email: string; username: string | null; display_name: string | null }>();
  return c.json({
    ok: true,
    user: { id: row.user_id, email: u?.email ?? '', username: u?.username ?? null, displayName: u?.display_name ?? null },
  });
});

// ---- Management: list / remove passkeys on the current account. ----

passkeys.get('/list', requireAuth(), async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    'SELECT credential_id, label, created_at, last_used_at FROM passkey_credentials WHERE user_id = ? ORDER BY created_at ASC'
  )
    .bind(user.id)
    .all<{ credential_id: string; label: string | null; created_at: number; last_used_at: number | null }>();
  return c.json({
    passkeys: results.map((r) => ({
      id: r.credential_id,
      label: r.label ?? 'Passkey',
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
  });
});

passkeys.delete('/:credentialId', requireAuth(), async (c) => {
  const user = c.get('user');
  await c.env.DB.prepare('DELETE FROM passkey_credentials WHERE credential_id = ? AND user_id = ?')
    .bind(c.req.param('credentialId'), user.id)
    .run();
  return c.json({ ok: true });
});
