// Content ownership — the rule the whole external-source story rests on
// (AB#7422 / AB#7426, plan §8): *whoever owns the content owns the edit button*.
//
// This runs the REAL engine (packages/worker/src/lib/content.ts) over the REAL
// Node-side storage driver (platforms/azure/content-store.mjs, the same one
// server.mjs binds when STORYLARK_LOCAL_CONTENT is set) against a REAL manifest
// produced by the pipeline. Nothing here is stubbed: the files are on disk, the
// manifest is rewritten, and the assertions are about what the next request
// would actually read back.
//
// The HTTP-level half of this — every write route refusing synced content with
// a 409 — is proven against a running deployment; see docs/content-sync.md.
// What is guarded HERE is the decision itself and the defaults it turns on,
// because those are what a future change is most likely to break quietly:
//
//   • content published before `origin` existed must default to EDITABLE
//   • only `sync` is read-only, and it is read-only through every path
//   • a portal edit must not relabel where content came from
//
//   node --import tsx/esm --test packages/worker/test/content-origin.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localContentStore } from '../../../platforms/azure/content-store.mjs';
import {
  MANIFEST_KEY,
  effectiveOrigin,
  isManagedExternally,
  managedExternallyMessage,
  originOf,
  readManifest,
  saveChapter,
  syncSourceOf,
} from '../src/lib/content.ts';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

/**
 * A library holding all four cases at once, which is the whole point of
 * recording origin per book rather than as a deployment-wide mode: a deployment
 * can carry a synced catalogue AND portal-written stories AND an old CLI
 * library, each behaving correctly, with no global switch.
 *
 * `legacy-library` is modelled on the real production manifest as it stands
 * today (content.storylark.dev, libraryVersion 3): no `origin` key anywhere,
 * and no `source` key either.
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'storylark-origin-'));
  const manifest = {
    schemaVersion: 1,
    libraryVersion: 7,
    announceVersion: 7,
    generatedAt: new Date().toISOString(),
    books: [
      {
        id: 'legacy-library',
        title: 'Published Before Origin Existed',
        chapters: [
          {
            id: 'full',
            title: 'A Legacy Chapter',
            wordCount: 9,
            audioDurationMs: 0,
            contentHash: 'aaaaaaaa',
            content: 'books/legacy-library/chapters/full.aaaaaaaa.json',
            hasAudio: false,
          },
        ],
      },
      {
        id: 'cli-library',
        title: 'Published From A Laptop',
        origin: 'cli',
        chapters: [
          {
            id: 'full',
            title: 'A CLI Chapter',
            wordCount: 9,
            audioDurationMs: 0,
            contentHash: 'bbbbbbbb',
            content: 'books/cli-library/chapters/full.bbbbbbbb.json',
            source: 'books/cli-library/source/full.md',
            hasAudio: true,
          },
        ],
      },
      {
        id: 'synced-library',
        title: "Somebody Else's Catalogue",
        origin: 'sync',
        syncSource: { kind: 'git', url: 'https://git.example.com/press/site.git', ref: 'main', syncedAt: '2026-08-16T00:00:00.000Z' },
        chapters: [
          {
            id: 'chapter-one',
            title: 'A Synced Chapter',
            wordCount: 9,
            audioDurationMs: 0,
            contentHash: 'cccccccc',
            content: 'books/synced-library/chapters/chapter-one.cccccccc.json',
            source: 'books/synced-library/source/chapter-one.md',
            hasAudio: true,
            origin: 'sync',
          },
        ],
      },
    ],
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const [book, chapter, hash] of [
    ['legacy-library', 'full', 'aaaaaaaa'],
    ['cli-library', 'full', 'bbbbbbbb'],
    ['synced-library', 'chapter-one', 'cccccccc'],
  ]) {
    const file = join(dir, 'books', book, 'chapters', `${chapter}.${hash}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ id: chapter, bookId: book, title: 'x', blocks: [{ id: 'b1', type: 'paragraph', text: 'The original words, as published.' }], charLength: 33 })
    );
  }
  return { dir, store: localContentStore(dir) };
}

test('content with no origin field — the real shape of every pre-AB#7422 library — is treated as cli, and stays editable', async () => {
  const { dir, store } = await fixture();
  try {
    const manifest = await readManifest(store);
    const legacy = manifest.books.find((b) => b.id === 'legacy-library');

    assert.equal(legacy.origin, undefined, 'fixture must actually be missing the field');
    assert.equal(originOf(legacy), 'cli');
    assert.equal(originOf(legacy.chapters[0]), 'cli');
    assert.equal(effectiveOrigin(legacy, legacy.chapters[0]), 'cli');
    assert.equal(isManagedExternally(legacy), false, 'an old library must never become read-only by omission');
    assert.equal(isManagedExternally(legacy.chapters[0]), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only sync is read-only; portal and cli are not, and an unknown future origin fails open', async () => {
  assert.equal(isManagedExternally({ origin: 'sync' }), true);
  assert.equal(isManagedExternally({ origin: 'cli' }), false);
  assert.equal(isManagedExternally({ origin: 'portal' }), false);
  assert.equal(isManagedExternally({ origin: 'personal' }), false);
  // A newer writer's unrecognised value must not lock an operator out of their
  // own library — mislabelling is a smaller failure than refusing an edit.
  assert.equal(originOf({ origin: 'something-new' }), 'cli');
  assert.equal(isManagedExternally({ origin: 'something-new' }), false);
  assert.equal(originOf(undefined), 'cli');
});

test('a chapter inherits its book’s origin when it does not state one', async () => {
  const { dir, store } = await fixture();
  try {
    const manifest = await readManifest(store);
    const synced = manifest.books.find((b) => b.id === 'synced-library');
    // Simulate a chapter written into a synced book by an older pipeline that
    // had no per-chapter origin: the book still protects it.
    const inherited = { id: 'no-origin-of-its-own', wordCount: 1, audioDurationMs: 0, contentHash: 'd', content: 'x', hasAudio: false };
    assert.equal(effectiveOrigin(synced, inherited), 'sync');
    assert.equal(effectiveOrigin(synced, synced.chapters[0]), 'sync');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the refusal names the real source, in both connector shapes', async () => {
  const git = managedExternallyMessage('press-catalogue', { kind: 'git', url: 'https://git.example.com/press/site.git', ref: 'main' }, '"press-catalogue/one"');
  assert.match(git, /edit it at source/i);
  assert.match(git, /https:\/\/git\.example\.com\/press\/site\.git/);
  assert.match(git, /branch main/);
  assert.match(git, /overwritten/i, 'it has to say WHY, not just no');

  const feed = managedExternallyMessage('press-catalogue', { kind: 'feed', url: 'https://press.example.com/storylark.json' }, '"press-catalogue"');
  assert.match(feed, /https:\/\/press\.example\.com\/storylark\.json/);

  // A synced book whose source was never recorded still gets a usable answer.
  const bare = managedExternallyMessage('press-catalogue', undefined, '"press-catalogue"');
  assert.match(bare, /external source system/i);
});

test('syncSourceOf only trusts the two supported kinds', async () => {
  assert.equal(syncSourceOf({ syncSource: { kind: 'git', url: 'u' } }).kind, 'git');
  assert.equal(syncSourceOf({ syncSource: { kind: 'feed', url: 'u' } }).kind, 'feed');
  assert.equal(syncSourceOf({ syncSource: { kind: 'dropbox', url: 'u' } }), undefined);
  assert.equal(syncSourceOf({}), undefined);
  assert.equal(syncSourceOf(undefined), undefined);
});

test('a portal save keeps the origin the content already had, and a new chapter is portal-owned', async () => {
  const { dir, store } = await fixture();
  try {
    const env = {};
    // Editing CLI-published content in the portal is allowed and does NOT
    // relabel it: the laptop copy still exists, and `publish.mjs --pull` is
    // what reconciles the two.
    await saveChapter({
      store,
      env,
      bookId: 'cli-library',
      chapterId: 'full',
      markdown: '---\ntitle: A CLI Chapter\n---\n\nFixed a typo in the portal.\n',
      correction: true,
      savedBy: 'ops',
    });
    // Same for a chapter that predates the field entirely.
    await saveChapter({
      store,
      env,
      bookId: 'legacy-library',
      chapterId: 'full',
      markdown: '---\ntitle: A Legacy Chapter\n---\n\nFixed a typo in a very old library.\n',
      correction: true,
      savedBy: 'ops',
    });
    // And something genuinely new here is ours.
    await saveChapter({
      store,
      env,
      bookId: 'written-here',
      chapterId: 'full',
      markdown: '---\ntitle: Written Here\n---\n\nTyped into the portal.\n',
      correction: false,
      savedBy: 'ops',
    });

    const after = JSON.parse(await readFile(join(dir, MANIFEST_KEY), 'utf8'));
    const book = (id) => after.books.find((b) => b.id === id);

    assert.equal(book('cli-library').chapters[0].origin, 'cli');
    assert.equal(book('legacy-library').chapters[0].origin, 'cli', 'an absent origin resolves to cli, it does not become portal');
    assert.equal(book('written-here').origin, 'portal');
    assert.equal(book('written-here').chapters[0].origin, 'portal');
    // Nothing above went anywhere near the synced book.
    assert.equal(book('synced-library').origin, 'sync');
    assert.equal(book('synced-library').chapters[0].origin, 'sync');
    assert.equal(book('synced-library').syncSource.url, 'https://git.example.com/press/site.git');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The scope line, enforced by a test rather than by a comment.
 *
 * Plan §8 is explicit: exactly two pull connectors, and no bespoke ones ever.
 * "We'll write a connector for your CMS" is the one commitment in this design
 * that could never be finished, so a third `kind` must fail loudly and point at
 * the API instead.
 */
test('sync.mjs supports exactly two connectors and refuses to grow a third', async () => {
  await assert.rejects(
    () => run(process.execPath, [join(REPO, 'packages', 'pipeline', 'sync.mjs'), '--brand', 'storylark-local', '--kind', 'dropbox', '--url', 'https://example.com'], { cwd: REPO }),
    (err) => {
      assert.match(err.stderr, /Unknown sync kind "dropbox"/);
      assert.match(err.stderr, /exactly two/);
      assert.match(err.stderr, /content API/, 'it must say what to do instead');
      return true;
    }
  );
});

test('sync.mjs refuses a URL with an embedded credential', async () => {
  await assert.rejects(
    () => run(process.execPath, [join(REPO, 'packages', 'pipeline', 'sync.mjs'), '--brand', 'storylark-local', '--kind', 'git', '--url', 'https://user:hunter2@git.example.com/x.git'], { cwd: REPO }),
    (err) => {
      assert.match(err.stderr, /STORYLARK_SYNC_TOKEN/);
      assert.doesNotMatch(err.stderr, /hunter2/, 'and it must not echo the secret back');
      return true;
    }
  );
});
