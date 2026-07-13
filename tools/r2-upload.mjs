// R2 uploads via wrangler. Hashed paths get immutable cache headers; the
// manifest gets a short TTL and is always uploaded LAST so readers never see
// a manifest pointing at missing objects.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function putObject(bucket, key, file, contentType, cacheControl) {
  const win = process.platform === 'win32';
  // With shell:true (required for wrangler.cmd on Windows), args containing
  // spaces must be quoted by hand or the shell splits them.
  const q = (s) => (win && /[\s,]/.test(s) ? `"${s}"` : s);
  await run(
    'wrangler',
    [
      'r2', 'object', 'put', q(`${bucket}/${key}`),
      '--file', q(file),
      '--content-type', q(contentType),
      '--cache-control', q(cacheControl),
      '--remote',
    ],
    { shell: win }
  );
}

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const SHORT = 'public, max-age=60';

export async function putJson(bucket, key, file, immutable = true) {
  await putObject(bucket, key, file, 'application/json', immutable ? IMMUTABLE : SHORT);
}

export async function putAudio(bucket, key, file) {
  await putObject(bucket, key, file, 'audio/mpeg', IMMUTABLE);
}

export async function putImage(bucket, key, file) {
  const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  await putObject(bucket, key, file, type, IMMUTABLE);
}
