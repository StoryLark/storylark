// Same-origin content serving (AB#7395) — the route that makes CONTENT_ORIGIN
// optional: with no content domain configured, GET /manifest.json and
// GET /books/* answer straight out of the deployment's own content storage.
//
// This runs the REAL Worker app (packages/worker/src/index.ts) over the REAL
// Node-side storage driver (platforms/azure/content-store.mjs) against a REAL
// manifest layout — the same shape `publish.mjs` writes. Nothing is stubbed
// except ASSETS, which answers 404 so the test can see when a request fell
// through to the asset router instead of being served from storage.
//
// The R2-binding half of the route (Range requests, conditional gets, stored
// cache-control metadata) can only be proven against a running Worker — see
// the wrangler-dev verification recorded with AB#7395 — but the routing rules
// guarded HERE are what a future change is most likely to break quietly:
//
//   • /manifest.json and /books/* serve from storage, with the pipeline's
//     exact cache policy (manifest SHORT, everything else IMMUTABLE)
//   • a key that is NOT public content (themes/*, /api/*) is never served
//   • a missing object falls through to the asset router, because that is
//     what `publish.mjs --local app/dist` relies on
//
//   node --import tsx/esm --test packages/worker/test/same-origin-content.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { localContentStore } from '../../../platforms/azure/content-store.mjs';
import { app } from '../src/index.ts';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'storylark-same-origin-'));
  const manifest = {
    schemaVersion: 1,
    libraryVersion: 3,
    generatedAt: new Date().toISOString(),
    books: [
      {
        id: 'the-lantern',
        title: 'The Lantern',
        cover: 'books/the-lantern/covers/cover.abc123.png',
        chapters: [
          {
            id: 'one',
            title: 'Chapter One',
            wordCount: 6,
            audioDurationMs: 0,
            contentHash: 'deadbeef',
            content: 'books/the-lantern/chapters/one.deadbeef.json',
            hasAudio: false,
          },
        ],
      },
    ],
  };
  const files = {
    'manifest.json': JSON.stringify(manifest),
    'books/the-lantern/chapters/one.deadbeef.json': JSON.stringify({
      id: 'one',
      bookId: 'the-lantern',
      blocks: [{ id: 'b1', type: 'paragraph', text: 'Six words is enough for this.' }],
      charLength: 30,
    }),
    // A real PNG header is not needed — what is under test is that the byte
    // body round-trips and the content type comes from the key's extension.
    'books/the-lantern/covers/cover.abc123.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    // In the bucket, NOT public content: the theme store's state lives beside
    // the books, and the same-origin route must never expose it.
    'themes/active.json': JSON.stringify({ version: 1 }),
  };
  for (const [key, body] of Object.entries(files)) {
    const file = join(dir, key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  const env = {
    CONTENT_STORE: localContentStore(dir),
    BRAND: 'same-origin-test',
    APP_ORIGIN: 'https://app.example.test',
    // The point of the whole change: nothing configured here.
    CONTENT_ORIGIN: '',
    // 404, so a fall-through to the asset router is visible as a 404 below.
    ASSETS: { fetch: async () => new Response('asset-router', { status: 404 }) },
  };
  const get = (path, init) => app.fetch(new Request(`https://app.example.test${path}`, init), env, {
    waitUntil() {},
    passThroughOnException() {},
  });
  return { dir, get };
}

test('the manifest serves same-origin, as JSON, with the pipeline’s SHORT cache policy', async () => {
  const { dir, get } = await fixture();
  try {
    const res = await get('/manifest.json');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60', 'the manifest names the whole library — it must never be immutable');
    const manifest = await res.json();
    assert.equal(manifest.books[0].id, 'the-lantern');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hashed chapter JSON and cover art serve same-origin, immutable, typed by extension', async () => {
  const { dir, get } = await fixture();
  try {
    const chapter = await get('/books/the-lantern/chapters/one.deadbeef.json');
    assert.equal(chapter.status, 200);
    assert.match(chapter.headers.get('content-type'), /application\/json/);
    assert.equal(chapter.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await chapter.json()).blocks[0].text, 'Six words is enough for this.');

    const cover = await get('/books/the-lantern/covers/cover.abc123.png');
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get('content-type'), 'image/png');
    assert.equal(cover.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await cover.arrayBuffer()).byteLength, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HEAD answers with headers and no body', async () => {
  const { dir, get } = await fixture();
  try {
    const res = await get('/manifest.json', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing object falls through to the asset router — the --local app/dist shape keeps working', async () => {
  const { dir, get } = await fixture();
  try {
    const res = await get('/books/no-such-book/chapters/none.json');
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'asset-router', 'the asset router, not a bare 404 minted here');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only the two public content prefixes are served — theme state and the API are not exposed', async () => {
  const { dir, get } = await fixture();
  try {
    // themes/active.json IS in the store; it must still not come out here.
    const theme = await get('/themes/active.json');
    assert.equal(theme.status, 404);
    assert.equal(await theme.text(), 'asset-router');

    // And the API surface is untouched by the content routes.
    const health = await get('/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).brand, 'same-origin-test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
