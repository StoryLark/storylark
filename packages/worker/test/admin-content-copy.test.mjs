import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, '../../core/src/screens/admin/ContentSection.tsx'), 'utf8');
const themeSource = readFileSync(join(HERE, '../../core/src/screens/admin/ThemeSection.tsx'), 'utf8');

test('admin content section welcomes both stories and books', () => {
  assert.match(source, /const CONTENT_SECTION_TITLE = 'Stories & Books';/);
  assert.equal(
    [...source.matchAll(/<h2>\{CONTENT_SECTION_TITLE\}<\/h2>/g)].length,
    4,
    'every content-section state uses the inclusive heading',
  );
  assert.doesNotMatch(source, /<h2>\{[^\n]*(?:'Stories'|'Books')[^\n]*\}<\/h2>/);
});

test('admin theme history identifies theme versions explicitly', () => {
  assert.match(themeSource, /<h3>Theme version history<\/h3>/);
  assert.match(themeSource, /Theme: <strong>\{v\.name\}<\/strong> v\{v\.version\}/);
});
