// Chapter reorder + conflict detection (AB#7412 — the last two items plan §3
// listed as "NOT built").
//
// Both are tested against the REAL engine (packages/worker/src/lib/content.ts)
// over the REAL Node-side storage driver (platforms/azure/content-store.mjs —
// the one server.mjs binds when STORYLARK_LOCAL_CONTENT is set), following the
// pattern content-origin.test.mjs established. Nothing is stubbed: the manifest
// is on disk, saves rewrite it, and every assertion is about what the next
// request would actually read back.
//
//   node --import tsx/esm --test packages/worker/test/chapter-order-conflict.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localContentStore } from '../../../platforms/azure/content-store.mjs';
import { detectSaveConflict, readManifest, reorderChapters, saveChapter, writeManifest } from '../src/lib/content.ts';

const ENV = { CONTENT_REVISIONS: '5' };

async function library(chapterIds) {
  const dir = await mkdtemp(join(tmpdir(), 'storylark-order-'));
  const store = localContentStore(dir);
  await writeManifest(store, {
    schemaVersion: 1,
    libraryVersion: 4,
    announceVersion: 4,
    generatedAt: new Date().toISOString(),
    books: [
      {
        id: 'the-long-road',
        title: 'The Long Road',
        origin: 'cli',
        chapters: chapterIds.map((id, i) => ({
          id,
          title: id,
          wordCount: 10,
          audioDurationMs: 0,
          contentHash: `hash${i}`,
          content: `books/the-long-road/chapters/${id}.hash${i}.json`,
          hasAudio: false,
        })),
      },
    ],
  });
  return { dir, store };
}

const ids = (book) => book.chapters.map((ch) => ch.id);

/* ── Reorder ─────────────────────────────────────────────────────────────── */

test('reorderChapters permutes the array, which IS the chapter order', async () => {
  const { dir, store } = await library(['one', 'two', 'three']);
  const manifest = await readManifest(store);
  const book = manifest.books[0];

  const result = reorderChapters(book.chapters, ['three', 'one', 'two']);
  assert.equal(result.ok, true);
  book.chapters = result.chapters;
  await writeManifest(store, manifest);

  // Read back through the store, not from the object we just mutated.
  assert.deepEqual(ids((await readManifest(store)).books[0]), ['three', 'one', 'two']);
  await rm(dir, { recursive: true, force: true });
});

test('a reorder carries every chapter entry through untouched', async () => {
  const { dir, store } = await library(['one', 'two']);
  const before = (await readManifest(store)).books[0].chapters;
  const result = reorderChapters(before, ['two', 'one']);
  assert.equal(result.ok, true);
  // Same objects, different order — a reorder must not be a chance to lose a
  // field a newer pipeline wrote.
  assert.deepEqual(result.chapters, [before[1], before[0]]);
  await rm(dir, { recursive: true, force: true });
});

test('a reorder that would DELETE a chapter is refused', async () => {
  // The realistic version of this: a browser tab open since before a `publish`
  // added chapter four, sending back the three ids it knows about. Accepting
  // that would silently unpublish the fourth.
  const { dir, store } = await library(['one', 'two', 'three', 'four']);
  const chapters = (await readManifest(store)).books[0].chapters;
  const result = reorderChapters(chapters, ['three', 'one', 'two']);
  assert.equal(result.ok, false);
  assert.match(result.message, /4 chapter|three chapter|Reload/i);
  await rm(dir, { recursive: true, force: true });
});

test('a reorder naming a chapter that does not exist is refused', async () => {
  const { dir, store } = await library(['one', 'two']);
  const chapters = (await readManifest(store)).books[0].chapters;
  const result = reorderChapters(chapters, ['one', 'ghost']);
  assert.equal(result.ok, false);
  assert.match(result.message, /ghost/);
  await rm(dir, { recursive: true, force: true });
});

test('a reorder repeating a chapter is refused', async () => {
  const { dir, store } = await library(['one', 'two']);
  const chapters = (await readManifest(store)).books[0].chapters;
  const result = reorderChapters(chapters, ['one', 'one']);
  assert.equal(result.ok, false);
  assert.match(result.message, /more than once/);
  await rm(dir, { recursive: true, force: true });
});

test('reordering, then saving a chapter, keeps the new order', async () => {
  // "Save" rewrites the manifest, so it is exactly the operation that could
  // quietly undo a reorder by rebuilding the list from somewhere else.
  const { dir, store } = await library(['one', 'two', 'three']);
  const manifest = await readManifest(store);
  const result = reorderChapters(manifest.books[0].chapters, ['three', 'two', 'one']);
  assert.equal(result.ok, true);
  manifest.books[0].chapters = result.chapters;
  await writeManifest(store, manifest);

  await saveChapter({
    store,
    env: ENV,
    bookId: 'the-long-road',
    chapterId: 'two',
    markdown: '---\ntitle: Two\n---\n\nRewritten in the portal.\n',
    correction: true,
    savedBy: 'operator',
  });

  assert.deepEqual(ids((await readManifest(store)).books[0]), ['three', 'two', 'one']);
  await rm(dir, { recursive: true, force: true });
});

test('a chapter created after a reorder is appended, not inserted', async () => {
  const { dir, store } = await library(['one', 'two']);
  const manifest = await readManifest(store);
  manifest.books[0].chapters = reorderChapters(manifest.books[0].chapters, ['two', 'one']).chapters;
  await writeManifest(store, manifest);

  await saveChapter({
    store,
    env: ENV,
    bookId: 'the-long-road',
    chapterId: 'three',
    markdown: '---\ntitle: Three\n---\n\nBrand new.\n',
    correction: false,
    savedBy: 'operator',
  });
  assert.deepEqual(ids((await readManifest(store)).books[0]), ['two', 'one', 'three']);
  await rm(dir, { recursive: true, force: true });
});

/* ── Conflict detection ──────────────────────────────────────────────────── */

test('no base hash means no conflict — the pre-AB#7412 behaviour is untouched', () => {
  const live = { id: 'one', contentHash: 'newer', wordCount: 1, audioDurationMs: 0, content: 'x', hasAudio: false };
  assert.equal(detectSaveConflict(live, undefined), null);
  assert.equal(detectSaveConflict(live, ''), null);
});

test('a base hash matching what is live is not a conflict', () => {
  const live = { id: 'one', contentHash: 'abc12345', wordCount: 1, audioDurationMs: 0, content: 'x', hasAudio: false };
  assert.equal(detectSaveConflict(live, 'abc12345'), null);
});

test('creating a chapter that does not exist yet is never a conflict', () => {
  assert.equal(detectSaveConflict(undefined, 'abc12345'), null);
});

test('a base hash behind what is live IS a conflict, and says both versions', () => {
  const live = { id: 'one', contentHash: 'newer000', wordCount: 1, audioDurationMs: 0, content: 'x', hasAudio: false };
  const conflict = detectSaveConflict(live, 'older000');
  assert.ok(conflict);
  assert.equal(conflict.liveContentHash, 'newer000');
  assert.match(conflict.message, /older000/);
  assert.match(conflict.message, /newer000/);
  // The refusal has to say what to do, not just that it said no.
  assert.match(conflict.message, /Reload/);
});

test('the real sequence: open at one hash, a publish lands, the save is refused', async () => {
  const { dir, store } = await library(['one', 'two']);

  // 1. The portal opens chapter "one" and is handed its content hash.
  const opened = (await readManifest(store)).books[0].chapters.find((ch) => ch.id === 'one');
  const baseContentHash = opened.contentHash;

  // 2. Something else saves it while the operator is typing. A CLI publish and
  //    another browser tab are indistinguishable from here, and both must be
  //    caught — the manifest afterwards records only the winner.
  const landed = await saveChapter({
    store,
    env: ENV,
    bookId: 'the-long-road',
    chapterId: 'one',
    markdown: '---\ntitle: One\n---\n\nText that landed while you were typing.\n',
    correction: true,
    savedBy: 'publish.mjs',
  });
  assert.notEqual(landed.contentHash, baseContentHash);

  // 3. The editor's save, carrying the hash it opened at, is refused.
  const now = (await readManifest(store)).books[0].chapters.find((ch) => ch.id === 'one');
  const conflict = detectSaveConflict(now, baseContentHash);
  assert.ok(conflict, 'a save against a superseded version must be refused');
  assert.equal(conflict.liveContentHash, landed.contentHash);

  // 4. Reloading resolves it: the editor now holds the live version.
  assert.equal(detectSaveConflict(now, landed.contentHash), null);
  await rm(dir, { recursive: true, force: true });
});

test('saving twice from the same editor without reloading is a conflict the second time', async () => {
  // The everyday version: two tabs, or a double submit against a slow network.
  const { dir, store } = await library(['one']);
  const base = (await readManifest(store)).books[0].chapters[0].contentHash;

  const first = await saveChapter({
    store,
    env: ENV,
    bookId: 'the-long-road',
    chapterId: 'one',
    markdown: '---\ntitle: One\n---\n\nFirst edit.\n',
    correction: true,
    savedBy: 'tab-a',
  });
  const live = (await readManifest(store)).books[0].chapters[0];
  assert.equal(detectSaveConflict(live, base)?.liveContentHash, first.contentHash);
  await rm(dir, { recursive: true, force: true });
});
