import { b64url, b64urlDecode } from './crypto';

/**
 * Payload-less Web Push: sign a VAPID JWT (ES256) and POST an empty body.
 * No RFC 8291 payload encryption is needed — the service worker fetches
 * the latest library manifest itself when woken.
 */
export async function sendPush(
  endpoint: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  subject: string
): Promise<number> {
  const { origin } = new URL(endpoint);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({ aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })
    )
  );
  const key = await importVapidPrivateKey(vapidPrivateKey, vapidPublicKey);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${payload}`));
  const jwt = `${header}.${payload}.${b64url(sig)}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Authorization: `vapid t=${jwt}, k=${vapidPublicKey}`,
      'Content-Length': '0',
    },
  });
  return res.status;
}

async function importVapidPrivateKey(privateB64url: string, publicB64url: string): Promise<CryptoKey> {
  // VAPID keys are raw P-256: private = 32-byte d, public = 65-byte uncompressed point.
  const d = b64urlDecode(privateB64url);
  const pub = b64urlDecode(publicB64url);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: b64url(d),
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
