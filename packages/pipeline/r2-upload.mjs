// R2 uploads via wrangler. Hashed paths get immutable cache headers; the
// manifest gets a short TTL and is always uploaded LAST so readers never see
// a manifest pointing at missing objects.
//
// Local mode: when STORYLARK_LOCAL_R2 is set (via `publish.mjs --local <dir>`),
// objects are mirrored into that directory instead of a remote bucket, so you
// can publish + serve content with no Cloudflare account. Keys map to
// <dir>/<key>; the bucket name is dropped because an R2 custom domain serves
// the bucket root at the domain root — which is exactly what the brand's
// contentOrigin points at.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export function resolveWranglerCli() {
  try {
    return require.resolve('wrangler');
  } catch {
    throw new Error(
      'The R2 publisher requires the local `wrangler` package. Run `npm install` in the publisher project before publishing or narrating.'
    );
  }
}

export async function putObject(bucket, key, file, contentType, cacheControl) {
  const localDir = process.env.STORYLARK_LOCAL_R2;
  if (localDir) {
    const dest = join(localDir, key);
    await mkdir(dirname(dest), { recursive: true });
    await cp(file, dest); // MIME/caching come from the serving layer by extension
    return;
  }
  // Resolve the publisher project's installed Wrangler module instead of
  // assuming node_modules/.bin happens to be on PATH. Direct `node ...`
  // invocations in CI do not receive npm's temporary PATH augmentation.
  await run(
    process.execPath,
    [
      resolveWranglerCli(),
      'r2', 'object', 'put', `${bucket}/${key}`,
      '--file', file,
      '--content-type', contentType,
      '--cache-control', cacheControl,
      '--remote',
    ]
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
