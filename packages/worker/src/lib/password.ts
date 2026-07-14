// Password hashing for the email + username + password sign-in path.
// PBKDF2-SHA256 via WebCrypto (crypto.subtle), the same "no Node APIs, no
// nodejs_compat flag" constraint as the rest of worker/src/lib (see
// docs/auth.md's passkey section for the same reasoning applied to WebAuthn).
// Cloudflare Workers' SubtleCrypto implementation supports PBKDF2 natively.

import { bufToHex, hexToBuf } from './crypto';

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256; // matches the SHA-256 digest size used to derive it

export interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

/** Hashes a brand-new password with a fresh random salt. */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const saltBytes = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(saltBytes);
  const salt = bufToHex(saltBytes);
  const hash = await derive(password, salt, ITERATIONS);
  return { hash, salt, iterations: ITERATIONS };
}

/** Re-derives against the stored (salt, iterations) and compares in constant time. */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const candidate = await derive(password, stored.salt, stored.iterations);
  return timingSafeEqual(candidate, stored.hash);
}

// Fixed, non-secret salt used ONLY to burn an equivalent PBKDF2 derive when
// there's no real stored hash to check against (unknown email/username, or
// an account with no password set yet), so "no such account" and "wrong
// password" take about the same amount of time and a login attempt can't be
// used to enumerate which accounts exist.
const DUMMY_SALT = '00'.repeat(SALT_BYTES);

export async function dummyVerify(password: string): Promise<void> {
  await derive(password, DUMMY_SALT, ITERATIONS);
}

async function derive(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBuf(saltHex), iterations },
    key,
    KEY_BITS
  );
  return bufToHex(bits);
}

/** Constant-time compare of two equal-length hex digests. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
