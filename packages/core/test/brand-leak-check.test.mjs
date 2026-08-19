import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findBrandLeaks } from '../bin/brand-leak-check.mjs';

test('dependency vocabulary is not mistaken for brand data, but unique copy is caught', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'storylark-brand-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const paths = {
    brand: join(root, 'brands', 'wireless'),
    presentation: join(root, 'presentation', 'wireless'),
    source: join(root, 'dependency-source'),
    dist: join(root, 'dist', 'assets'),
    core: join(root, 'core'),
  };
  Object.values(paths).forEach((path) => mkdirSync(path, { recursive: true }));

  writeFileSync(
    join(paths.brand, 'brand.json'),
    JSON.stringify({ id: 'wireless', tagline: 'Only Wren Harbor broadcasts after midnight.' })
  );
  writeFileSync(join(paths.presentation, 'presentation.json'), JSON.stringify({ nouns: { collection: 'serial' } }));
  writeFileSync(join(paths.source, 'library.mjs'), 'export const parserMode = "serial";\n');
  writeFileSync(join(paths.dist, 'app.js'), 'const parserMode="serial";\n');

  const options = {
    root,
    coreDir: paths.core,
    distDir: join(root, 'dist'),
    engineSourceRoots: [paths.source],
  };
  assert.deepEqual(findBrandLeaks(options), []);

  writeFileSync(join(paths.dist, 'app.js'), 'const copy="Only Wren Harbor broadcasts after midnight.";\n');
  assert.deepEqual(findBrandLeaks(options), [
    'assets/app.js  <- "Only Wren Harbor broadcasts after midnight." (brands/wireless/brand.json)',
  ]);
});
