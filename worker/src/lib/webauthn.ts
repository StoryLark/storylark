import type { Context } from 'hono';
import type { WebAuthnCredential } from '@simplewebauthn/server';
import type { AppContext } from '../types';
import { b64url, b64urlDecode, randomToken } from './crypto';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes — a WebAuthn ceremony is a single user gesture

export type ChallengePurpose = 'register' | 'login';

export interface RpConfig {
  rpID: string;
  rpName: string;
  origin: string;
}

/**
 * Brand-neutral by construction: APP_ORIGIN/APP_NAME are per-brand vars wired
 * per env in wrangler.jsonc and already used this same way elsewhere in auth.ts
 * (magic-link URL, Google redirect_uri). No brand id is ever referenced here.
 */
export function getRpConfig(c: Context<AppContext>): RpConfig {
  const origin = c.env.APP_ORIGIN;
  return { rpID: new URL(origin).hostname, rpName: c.env.APP_NAME, origin };
}

/** Stores a ceremony's challenge, single-use and short-lived — same shape as magic_links. */
export async function storeChallenge(
  db: D1Database,
  challenge: string,
  purpose: ChallengePurpose,
  userId: string | null
): Promise<string> {
  const id = randomToken(24);
  const now = Date.now();
  await db
    .prepare('INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, challenge, purpose, userId, now + CHALLENGE_TTL_MS)
    .run();
  return id;
}

/** Consumes (marks used) a challenge if it's unused, unexpired, and for the right purpose. */
export async function consumeChallenge(
  db: D1Database,
  id: string,
  purpose: ChallengePurpose
): Promise<{ challenge: string; userId: string | null } | null> {
  const now = Date.now();
  const row = await db
    .prepare(
      'SELECT challenge, user_id FROM webauthn_challenges WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?'
    )
    .bind(id, purpose, now)
    .first<{ challenge: string; user_id: string | null }>();
  if (!row) return null;
  await db.prepare('UPDATE webauthn_challenges SET used_at = ? WHERE id = ?').bind(now, id).run();
  return { challenge: row.challenge, userId: row.user_id };
}

export interface PasskeyRow {
  credential_id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
}

/** DB row → the shape @simplewebauthn/server's verify functions expect. */
export function toWebAuthnCredential(row: PasskeyRow): WebAuthnCredential {
  return {
    id: row.credential_id,
    publicKey: freshUint8Array(b64urlDecode(row.public_key)),
    counter: row.counter,
    transports: row.transports ? JSON.parse(row.transports) : undefined,
  };
}

/**
 * TypeScript's lib types now parameterize `Uint8Array` by its backing buffer
 * (`ArrayBuffer` vs the broader `ArrayBufferLike`), and @simplewebauthn/server's
 * types want the `ArrayBuffer`-backed variant specifically while some Workers
 * runtime APIs (TextEncoder.encode, etc.) type their output as the broader one.
 * Allocating by length is the one constructor overload TS resolves to
 * `Uint8Array<ArrayBuffer>` unambiguously, so this copies into a fresh one —
 * cheap for the small buffers (public keys, a user id) this touches.
 */
export function freshUint8Array(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/** Friendly label guess from a User-Agent, shown in the passkey list (never authoritative, just a hint). */
export function labelFromUserAgent(ua: string | null): string {
  if (!ua) return 'Passkey';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone or iPad';
  if (/Android/.test(ua)) return 'Android device';
  if (/Windows/.test(ua)) return 'Windows device';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'Passkey';
}
