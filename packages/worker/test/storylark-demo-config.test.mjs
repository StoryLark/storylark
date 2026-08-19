// Production demo wiring (AB#7392): storylark.dev serves both the app and its
// bundled library. Keeping the content origin empty makes frontend URLs
// root-relative and avoids requiring cross-origin CORS on a fresh install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

test('the StoryLark demo serves its library from the canonical app origin', async () => {
  const deployment = JSON.parse(await readFile(join(REPO, 'deployment', 'storylark', 'deployment.json'), 'utf8'));
  const wrangler = await readFile(join(REPO, 'wrangler.jsonc'), 'utf8');

  assert.equal(deployment.appOrigin, 'https://storylark.dev');
  assert.equal(deployment.contentOrigin, '');
  assert.match(wrangler, /"APP_ORIGIN"\s*:\s*"https:\/\/storylark\.dev"/);
  assert.match(wrangler, /"CONTENT_ORIGIN"\s*:\s*""/);
  assert.doesNotMatch(wrangler, /content\.storylark\.dev/);
});
