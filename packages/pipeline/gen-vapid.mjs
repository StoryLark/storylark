// Generates a VAPID P-256 keypair. Public key goes into the deployment config
// (deployment/<id>/deployment.json, or STORYLARK_VAPID_PUBLIC_KEY at build time) —
// it is per-install, not part of a portable brand. Private key becomes the Worker
// secret VAPID_PRIVATE_KEY (raw d, base64url) and is never written to a file here.

import { webcrypto as crypto } from 'node:crypto';

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const raw = await crypto.subtle.exportKey('raw', pair.publicKey);

const b64url = (buf) => Buffer.from(buf).toString('base64url');

console.log('VAPID public key  (deployment/<id>/deployment.json → vapidPublicKey, worker secret VAPID_PUBLIC_KEY):');
console.log(b64url(raw));
console.log('\nVAPID private key (worker secret VAPID_PRIVATE_KEY):');
console.log(jwk.d);
