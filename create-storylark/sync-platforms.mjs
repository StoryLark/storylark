#!/usr/bin/env node
// Copies the engine repo's platforms/ into create-storylark/platforms/ so it
// ships as part of this package (see bin/create-storylark.mjs's copyPlatforms
// — a real npm install of create-storylark has no engine checkout nearby to
// read platforms/ from, so it has to be bundled in, not referenced). Run
// automatically before every publish (prepublishOnly); safe to run by hand
// too when iterating locally. The one true source is the root platforms/ —
// this directory is a mechanical copy, never hand-edited.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, '..', 'platforms');
const dest = join(__dirname, 'platforms');

if (!existsSync(src)) {
  console.error(`sync-platforms: ${src} not found — run from inside the engine repo checkout.`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, {
  recursive: true,
  filter: (p) => !p.endsWith('install.env') && !p.includes('node_modules'),
});
console.log(`Synced ${src} → ${dest}`);
