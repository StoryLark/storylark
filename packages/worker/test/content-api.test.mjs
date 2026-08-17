// The public content API — the PUSH contract and bulk import (AB#7412, plan §8
// items 1 and 3).
//
// These drive the REAL Hono app (packages/worker/src/index.ts) over real
// Requests, against a REAL sqlite database carrying the REAL shipped migrations
// and a REAL content store writing files to disk. Nothing is stubbed: the
// assertions are about what the next request would actually read back, and what
// is on the filesystem afterwards.
//
//   node --import tsx/esm --test packages/worker/test/content-api.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zip } from 'storylark-contracts/zip';
import { testDeployment, chapterMarkdown } from './sqlite-env.mjs';

test('the contract describes itself, and refuses a caller that will not say which version it wrote against', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const describe = await dep.call('GET', '/api/content/v1');
  assert.equal(describe.status, 200);
  assert.equal(describe.json.contractVersion, 1);
  assert.equal(describe.json.supported.min, 1);
  assert.equal(describe.json.storeAvailable, true);
  assert.equal(describe.json.defaults.managed, true, 'pushed content is read-only in the portal by default');
  assert.ok(describe.json.limits.maxBooksPerRequest > 0);

  // No contractVersion at all.
  const bare = await dep.call('PUT', '/api/content/v1/books/a-book', { chapters: [] });
  assert.equal(bare.status, 400);
  assert.equal(bare.json.error, 'contract_version_required');
  assert.match(bare.json.message, /contractVersion/);

  // A version from the future.
  const future = await dep.call('PUT', '/api/content/v1/books/a-book', { contractVersion: 99, chapters: [] });
  assert.equal(future.status, 400);
  assert.equal(future.json.error, 'contract_version_unsupported');
});

test('the push door is closed without a credential, and open with the admin key', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const anonymous = await dep.call('GET', '/api/content/v1', undefined, { 'X-Admin-Key': 'wrong' });
  assert.equal(anonymous.status, 401, 'a bad key must not reach the contract');

  const ok = await dep.call('GET', '/api/content/v1');
  assert.equal(ok.status, 200);
});

test('a push writes real content, marks it externally managed, and names the pushing system', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const res = await dep.call('PUT', '/api/content/v1/books/press-catalogue', {
    contractVersion: 1,
    title: 'The Press Catalogue',
    author: 'A Publisher',
    source: { url: 'https://press.example.com/books/press-catalogue', system: 'Acme CMS' },
    chapters: [
      { id: 'one', markdown: chapterMarkdown('One') },
      { id: 'two', markdown: chapterMarkdown('Two') },
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.summary.chaptersSucceeded, 2);

  const manifest = await dep.manifest();
  const book = manifest.books.find((b) => b.id === 'press-catalogue');
  assert.equal(book.title, 'The Press Catalogue');
  assert.equal(book.author, 'A Publisher');
  assert.equal(book.origin, 'sync', 'pushed content is owned by the system that pushed it');
  assert.equal(book.syncSource.kind, 'api');
  assert.equal(book.syncSource.system, 'Acme CMS');
  assert.equal(book.chapters.length, 2);

  // The source markdown really is on disk, under the key the portal reads.
  const source = await readFile(join(dep.dir, 'books', 'press-catalogue', 'source', 'one.md'), 'utf8');
  assert.match(source, /title: One/);
  // And the derived, content-hashed chapter JSON the app fetches.
  const derived = JSON.parse(await readFile(join(dep.dir, book.chapters[0].content), 'utf8'));
  assert.equal(derived.bookId, 'press-catalogue');
  assert.ok(derived.blocks.length > 0);
});

test('pushed content is read-only in the ADMIN PORTAL, with a message naming the pushing system', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  await dep.call('PUT', '/api/content/v1/books/press-catalogue', {
    contractVersion: 1,
    source: { url: 'https://press.example.com/x', system: 'Acme CMS' },
    chapters: [{ id: 'one', markdown: chapterMarkdown('One') }],
  });

  // The portal's own write route refuses it — the ownership rule, applied to the
  // third arrival route rather than only to the two pull connectors.
  const portal = await dep.call(
    'PUT',
    '/api/admin/content/books/press-catalogue/chapters/one',
    { markdown: chapterMarkdown('One', 'Typed in the portal instead.') },
    { 'X-Admin-Key': 'nope', 'X-Requested-With': 'storylark' }
  );
  assert.equal(portal.status, 401, 'the portal path is session-gated; without one there is nothing to refuse yet');

  // Prove the refusal itself at the layer that owns it, with a real manifest.
  const { managedExternallyMessage, isPullManaged, syncSourceOf } = await import('../src/lib/content.ts');
  const manifest = await dep.manifest();
  const book = manifest.books.find((b) => b.id === 'press-catalogue');
  const message = managedExternallyMessage('press-catalogue', syncSourceOf(book), '"press-catalogue/one"');
  assert.match(message, /Acme CMS/);
  assert.match(message, /content API/);
  assert.match(message, /edit it at source/i);
  // …and that the API itself is still allowed to update what it owns.
  assert.equal(isPullManaged(book), false, 'the API owns api-pushed content and may update it');
});

test('the API refuses to overwrite a book owned by a PULL connector', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  // Stage a git-synced book exactly as sync.mjs → publish.mjs would leave it.
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(dep.dir, { recursive: true });
  await writeFile(
    join(dep.dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      libraryVersion: 4,
      announceVersion: 4,
      generatedAt: new Date().toISOString(),
      books: [
        {
          id: 'their-repo',
          title: "Somebody Else's Catalogue",
          origin: 'sync',
          syncSource: { kind: 'git', url: 'https://git.example.com/press/site.git', ref: 'main' },
          chapters: [
            { id: 'one', title: 'One', wordCount: 9, audioDurationMs: 0, contentHash: 'aaa', content: 'x', hasAudio: false, origin: 'sync' },
          ],
        },
      ],
    })
  );

  const res = await dep.call('PUT', '/api/content/v1/books/their-repo', {
    contractVersion: 1,
    chapters: [{ id: 'one', markdown: chapterMarkdown('One') }],
  });
  assert.equal(res.status, 422, res.text);
  assert.match(res.json.message, /managed externally|edit it at source/i);
  assert.match(res.json.message, /git\.example\.com/, 'the refusal names the repo that owns it');

  // And nothing was written: the manifest is byte-identical.
  const after = await dep.manifest();
  assert.equal(after.libraryVersion, 4);
  assert.equal(after.books[0].chapters[0].contentHash, 'aaa');

  // A delete is refused the same way, with the same 409 the portal uses.
  const del = await dep.call('DELETE', '/api/content/v1/books/their-repo');
  assert.equal(del.status, 409);
  assert.equal(del.json.error, 'managed_externally');
});

test('a best-effort batch: one bad book in fifty does not cost the other forty-nine', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const books = [];
  for (let i = 0; i < 50; i++) {
    const id = `story-${String(i).padStart(2, '0')}`;
    books.push({
      id,
      title: `Story ${i}`,
      // Book 17 carries front matter that opens and never closes — the single
      // most likely real failure in a first-time catalogue import.
      chapters: [{ id: 'full', markdown: i === 17 ? '---\ntitle: Broken\n\nNo closing fence.\n' : chapterMarkdown(`Story ${i}`) }],
    });
  }

  const res = await dep.call('POST', '/api/content/v1/books', { contractVersion: 1, books });
  assert.equal(res.status, 207, 'a partial batch is a 207, not a 200 that hides the failure');
  assert.equal(res.json.ok, false);
  assert.equal(res.json.policy, 'best-effort');
  assert.equal(res.json.summary.books, 50);
  assert.equal(res.json.summary.booksSucceeded, 49);
  assert.equal(res.json.summary.booksFailed, 1);

  const failure = res.json.results.find((r) => !r.ok);
  assert.equal(failure.bookId, 'story-17');
  // The stable code from the ONE content gate (storylark-contracts/content) —
  // the same code the portal's save and a sync report would carry for the same
  // file. It replaced the old umbrella `invalid_markdown` when the gate became
  // shared across transports.
  assert.equal(failure.error, 'unclosed_frontmatter');
  assert.match(failure.message, /front matter/i, 'the report says WHAT was wrong, per item');
  assert.equal(failure.errors[0].code, 'unclosed_frontmatter', 'the structured error list rides along');

  const manifest = await dep.manifest();
  assert.equal(manifest.books.length, 49);
  assert.equal(manifest.books.find((b) => b.id === 'story-17'), undefined);
  assert.ok(manifest.books.find((b) => b.id === 'story-49'), 'books after the bad one still landed');
});

test('all-or-nothing writes nothing at all when any item fails validation', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const res = await dep.call('POST', '/api/content/v1/books', {
    contractVersion: 1,
    policy: 'all-or-nothing',
    books: [
      { id: 'good-one', chapters: [{ id: 'full', markdown: chapterMarkdown('Good') }] },
      { id: 'bad-one', chapters: [{ id: 'full', markdown: '---\ntitle: Broken\n' }] },
      { id: 'good-two', chapters: [{ id: 'full', markdown: chapterMarkdown('Also good') }] },
    ],
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'batch_rejected');
  assert.match(res.json.message, /Nothing was written/);

  // There is no manifest at all, because not one chapter was saved.
  await assert.rejects(() => dep.manifest(), /ENOENT/);
});

test('a bulk import reads a real zip of the markdown-folder layout', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const archive = await zip([
    { name: 'books/the-keepers/book.json', data: JSON.stringify({ title: 'The Keepers', author: 'H. Press' }) },
    { name: 'books/the-keepers/01-arrival.md', data: chapterMarkdown('Arrival') },
    { name: 'books/the-keepers/02-the-long-dark.md', data: chapterMarkdown('The Long Dark') },
    { name: 'books/a-short-story.md', data: chapterMarkdown('A Short Story') },
    { name: 'books/.DS_Store', data: 'junk' },
    { name: 'books/A Badly Named Folder/01-one.md', data: chapterMarkdown('One') },
    { name: 'README.md', data: '# not a book' },
  ]);

  const res = await dep.call('POST', '/api/content/v1/import', archive);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.summary.books, 2, 'two books; the stray README and the .DS_Store are not books');
  assert.equal(res.json.summary.chaptersSucceeded, 3);
  // The skipped entries are reported, with a reason each — an operator whose
  // 42-book import came back with 41 must not have to go looking.
  assert.ok(res.json.ignored.some((i) => i.name === 'README.md' && /books\//.test(i.reason)));
  assert.ok(
    res.json.ignored.some((i) => i.name.includes('A Badly Named Folder') && /not a usable book id/.test(i.reason)),
    'a folder name that cannot be an id is reported, never silently renamed'
  );

  const manifest = await dep.manifest();
  const keepers = manifest.books.find((b) => b.id === 'the-keepers');
  assert.equal(keepers.title, 'The Keepers');
  assert.equal(keepers.author, 'H. Press');
  assert.deepEqual(
    keepers.chapters.map((ch) => ch.id),
    ['arrival', 'the-long-dark'],
    'the numeric filename prefix orders the chapters and is stripped from the id'
  );
  const single = manifest.books.find((b) => b.id === 'a-short-story');
  assert.deepEqual(single.chapters.map((ch) => ch.id), ['full']);
});

test('a bulk import refuses a file that is not a zip, and one that holds no books', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const notAZip = await dep.call('POST', '/api/content/v1/import', new TextEncoder().encode('this is not a zip archive at all'));
  assert.equal(notAZip.status, 422);
  assert.equal(notAZip.json.error, 'invalid_archive');

  const empty = await zip([{ name: 'notes/thoughts.txt', data: 'nothing to see' }]);
  const emptyRes = await dep.call('POST', '/api/content/v1/import', empty);
  assert.equal(emptyRes.status, 422);
  assert.equal(emptyRes.json.error, 'empty_import');
  assert.match(emptyRes.json.message, /books\//, 'it says what the layout should look like');
});

test('the catalogue endpoint gives a pushing system what it needs to push only what changed', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  await dep.call('PUT', '/api/content/v1/books/a-book', {
    contractVersion: 1,
    chapters: [{ id: 'one', markdown: chapterMarkdown('One') }],
  });
  const first = await dep.call('GET', '/api/content/v1/catalogue');
  assert.equal(first.status, 200);
  const before = first.json.books[0].chapters[0].contentHash;
  assert.ok(before);
  assert.equal(first.json.books[0].writableByApi, true);

  // Push identical text: the hash must not move.
  await dep.call('PUT', '/api/content/v1/books/a-book', {
    contractVersion: 1,
    chapters: [{ id: 'one', markdown: chapterMarkdown('One') }],
  });
  const same = await dep.call('GET', '/api/content/v1/catalogue');
  assert.equal(same.json.books[0].chapters[0].contentHash, before, 'identical text is identical content');

  // Push different text: it must.
  await dep.call('PUT', '/api/content/v1/books/a-book', {
    contractVersion: 1,
    chapters: [{ id: 'one', markdown: chapterMarkdown('One', 'Genuinely different words this time around.') }],
  });
  const changed = await dep.call('GET', '/api/content/v1/catalogue');
  assert.notEqual(changed.json.books[0].chapters[0].contentHash, before);
});

test('replaceChapters is opt-in: a partial push never truncates a book', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  await dep.call('PUT', '/api/content/v1/books/a-book', {
    contractVersion: 1,
    chapters: [
      { id: 'one', markdown: chapterMarkdown('One') },
      { id: 'two', markdown: chapterMarkdown('Two') },
      { id: 'three', markdown: chapterMarkdown('Three') },
    ],
  });

  // A correction to one chapter must not be read as "the book now has one".
  await dep.call('PUT', '/api/content/v1/books/a-book', {
    contractVersion: 1,
    chapters: [{ id: 'two', markdown: chapterMarkdown('Two', 'Corrected.') }],
  });
  let manifest = await dep.manifest();
  assert.equal(manifest.books[0].chapters.length, 3);

  // Opting in does replace.
  const res = await dep.call('PUT', '/api/content/v1/books/a-book', {
    contractVersion: 1,
    replaceChapters: true,
    chapters: [{ id: 'one', markdown: chapterMarkdown('One') }],
  });
  assert.deepEqual(res.json.results[0].removed.sort(), ['three', 'two']);
  manifest = await dep.manifest();
  assert.deepEqual(manifest.books[0].chapters.map((c) => c.id), ['one']);
});

test('managed:false pushes content the portal can still edit', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  await dep.call('PUT', '/api/content/v1/books/my-own', {
    contractVersion: 1,
    managed: false,
    chapters: [{ id: 'full', markdown: chapterMarkdown('Mine') }],
  });
  const manifest = await dep.manifest();
  const book = manifest.books.find((b) => b.id === 'my-own');
  assert.equal(book.origin, 'portal');
  assert.equal(book.syncSource, undefined, 'unmanaged content records no external source');
});

test('every push queues the narration it just invalidated, and says so', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const res = await dep.call('POST', '/api/content/v1/books', {
    contractVersion: 1,
    books: [
      { id: 'one-book', chapters: [{ id: 'a', markdown: chapterMarkdown('A') }, { id: 'b', markdown: chapterMarkdown('B') }] },
      { id: 'two-book', chapters: [{ id: 'a', markdown: chapterMarkdown('A') }] },
    ],
  });
  assert.equal(res.json.narration.queued, 3);
  assert.ok(res.json.narration.batchId);
  assert.match(res.json.narration.message, /narrate\.mjs/, 'it names the command that does the work');

  const queue = await dep.call('GET', '/api/admin/narration');
  assert.equal(queue.json.available, true);
  assert.equal(queue.json.counts.pending, 3);
  assert.equal(queue.json.runtime.canProcessInDeployment, false);

  // …and opting out really does opt out.
  const quiet = await dep.call('PUT', '/api/content/v1/books/three-book', {
    contractVersion: 1,
    narrate: false,
    chapters: [{ id: 'a', markdown: chapterMarkdown('A') }],
  });
  assert.equal(quiet.json.narration.queued, 0);
  const after = await dep.call('GET', '/api/admin/narration');
  assert.equal(after.json.counts.pending, 3, 'still three — the opted-out push added none');
});

test('bad ids and bad shapes are refused before anything is written', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const badBook = await dep.call('POST', '/api/content/v1/books', {
    contractVersion: 1,
    books: [{ id: 'Not A Valid Id', chapters: [] }],
  });
  assert.equal(badBook.status, 400);
  assert.equal(badBook.json.error, 'invalid_book_id');

  const badChapter = await dep.call('POST', '/api/content/v1/books', {
    contractVersion: 1,
    books: [{ id: 'fine', chapters: [{ id: 'ALSO BAD', markdown: 'x' }] }],
  });
  assert.equal(badChapter.status, 400);
  assert.equal(badChapter.json.error, 'invalid_chapter_id');

  const duplicate = await dep.call('POST', '/api/content/v1/books', {
    contractVersion: 1,
    books: [{ id: 'fine', chapters: [{ id: 'a', markdown: 'x' }, { id: 'a', markdown: 'y' }] }],
  });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.json.error, 'duplicate_chapter');

  const urlMismatch = await dep.call('PUT', '/api/content/v1/books/one-name', {
    contractVersion: 1,
    id: 'another-name',
    chapters: [],
  });
  assert.equal(urlMismatch.status, 400);
  assert.match(urlMismatch.json.message, /have to agree/);

  await assert.rejects(() => dep.manifest(), /ENOENT/, 'not one of those wrote anything');
});
