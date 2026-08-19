import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { resolveWranglerCli } from '../r2-upload.mjs';

test('R2 uploads resolve the publisher project local Wrangler without relying on PATH', () => {
  const cli = resolveWranglerCli();
  assert.equal(isAbsolute(cli), true);
  assert.match(cli.replaceAll('\\', '/'), /node_modules\/wrangler\/.+\.js$/);
});
