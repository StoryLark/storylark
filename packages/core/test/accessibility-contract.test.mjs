import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../src/app.tsx', import.meta.url), 'utf8');
const reader = await readFile(new URL('../src/screens/Reader.tsx', import.meta.url), 'utf8');
const importer = await readFile(new URL('../src/screens/PersonalLibrary.tsx', import.meta.url), 'utf8');

test('the reader app exposes navigation and focus landmarks', () => {
  assert.match(app, /class="skip-link" href="#main-content"/);
  assert.match(app, /<main id="main-content" tabIndex=\{-1\}>/);
});

test('icon-only reader controls and the scrubber have accessible names and state', () => {
  assert.match(reader, /aria-label="Read" aria-pressed=/);
  assert.match(reader, /aria-label="Read and listen" aria-pressed=/);
  assert.match(reader, /role="slider"/);
  assert.match(reader, /aria-valuetext=/);
  assert.match(reader, /ArrowLeft.*ArrowRight.*Home.*End/s);
});

test('the personal-library dialog has an accessible name and description', () => {
  assert.match(importer, /aria-labelledby="personal-dialog-title"/);
  assert.match(importer, /aria-describedby="personal-dialog-description"/);
  assert.match(importer, /role="alert"/);
  assert.match(importer, /role="status"/);
});

test('every shipped theme keeps normal text and interactive accents at 4.5:1 or better', async () => {
  const brands = new URL('../../../brands/', import.meta.url);
  for (const entry of await readdir(brands, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const css = await readFile(new URL(`${entry.name}/theme.css`, brands), 'utf8');
    for (const block of css.matchAll(/:root(?:\[data-theme="(?:light|dark)"\])?\s*\{([^}]+)\}/g)) {
      const tokens = Object.fromEntries(
        [...block[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2]])
      );
      if (!tokens.bg) continue;
      for (const token of ['text', 'text-muted', 'text-faint', 'accent', 'link']) {
        if (!tokens[token]) continue;
        assert.ok(
          contrast(tokens[token], tokens.bg) >= 4.5,
          `${entry.name} ${token} ${tokens[token]} on ${tokens.bg} is below 4.5:1`
        );
      }
    }
  }
});

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
