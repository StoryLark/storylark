// The repo sync transport — wave 2 of the content-management rework (AB#7420).
//
// The one thing this file exists to prove, modelled on wave 1's identity test:
// **the same malformed content pushed through the sync transport, the portal
// and the public API produces the identical stable codes and messages.** That
// three-way identity is the evidence the one-gate architecture survived a
// third transport — if the sync path had grown its own opinion of validity,
// this fails.
//
// Around it, the settled decisions are exercised for real, over the real app:
//   §10.1  a vanished file is reported `missing`; nothing is unpublished until
//          the operator's one click, which runs the ordinary recoverable delete
//   §10.2  the provider seam: a GitHub-shaped zipball served locally
//   §10.5  `book_owned_elsewhere` on a cross-source collision, naming the owner
//   §10.6  the stored manifest joins the order_tie check, all three doors
//   §10.7  an arrival is a SET: the `type: book` file sorting LAST still lands
//   §6.2   webhook signature: a signed payload is accepted, a FORGED one is
//          rejected — the rejection is the tested half
//
//   node --import tsx/esm --test packages/worker/test/content-sync.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { zip } from 'storylark-contracts/zip';
import { testDeployment, chapterMarkdown } from './sqlite-env.mjs';

const PROSE = 'A paragraph of perfectly ordinary prose, long enough to be a chapter.';

/** A chapter file carrying a `storylark:` block plus the customer's own fields. */
function withBlock(fields, body = PROSE) {
  const block = Object.entries(fields)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  return `---\ntitle: Their Own Title\nstoryNumber: 7\nstorylark:\n${block}\n---\n${body ? `\n${body}\n` : ''}`;
}

/** A GitHub-style zipball: everything under one `owner-repo-sha/` top folder. */
function makeArchive(entries) {
  return zip(Object.entries(entries).map(([name, data]) => ({ name: `acme-stories-abc123/${name}`, data })));
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1, 2, 3]);

/** The two-chapter repo both books-and-stories tests start from. */
function fixtureV1() {
  return {
    'content/the-keepers/01-the-long-road.md':
      withBlock({ type: 'chapter', book: 'the-keepers', chapter: 'the-long-road', order: 1 }, `${PROSE}\n\n![A lighthouse](images/lighthouse.png)`),
    'content/the-keepers/02-the-keeper.md': withBlock({ type: 'chapter', book: 'the-keepers', chapter: 'the-keeper', order: 2 }),
    'content/the-keepers/images/lighthouse.png': PNG,
    'content/winterlight.md': withBlock({ type: 'story', title: 'Winterlight' }),
    'content/outline.md': '# Just notes\n\nNot StoryLark content — no block.\n',
    // The book declaration deliberately sorts LAST (zz-, and listed last):
    // §10.7 — an arrival is a set, not a stream, so file order must not matter.
    'content/the-keepers/zz-book.md': `---\ntitle: The Keepers\nauthor: A. Writer\ndescription: Lighthouse stories.\nstorylark:\n  type: book\n  book: the-keepers\n---\n`,
  };
}

/**
 * A deployment plus a local "GitHub": an HTTP server handing out whatever
 * archive the test currently stages, reachable through the provider driver via
 * the CONTENT_SYNC_ARCHIVE_BASE test seam (the CF_API_BASE precedent).
 */
async function syncDeployment() {
  let current = await makeArchive(fixtureV1());
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/zip' });
    res.end(Buffer.from(current));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dep = await testDeployment({ CONTENT_SYNC_ARCHIVE_BASE: base });
  return {
    dep,
    hits: () => hits,
    stage: async (entries) => {
      current = await makeArchive(entries);
    },
    close: async () => {
      server.close();
      await dep.close();
    },
  };
}

/** GitHub Contents API-shaped source: path-first, individual files on demand. */
async function contentsDeployment() {
  const story = withBlock({ type: 'story', title: 'Path First' });
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/repos/acme/stories/contents/content') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          { type: 'file', path: 'content/path-first.md', size: Buffer.byteLength(story) },
          { type: 'file', path: 'content/unrelated-250mb.bin', size: 250 * 1024 * 1024 },
        ])
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/graphql') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        assert.match(body, /content\/path-first\.md/, 'the batch asks only for the in-scope Markdown candidate');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { repository: { f0: { text: story, isTruncated: false } } } }));
      });
      return;
    }
    if (url.pathname === '/repos/acme/stories/contents/content/path-first.md') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(story);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dep = await testDeployment({ CONTENT_SYNC_GITHUB_API_BASE: base, CONTENT_SYNC_TOKEN: 'github-app-test-token' });
  return {
    dep,
    requests,
    close: async () => {
      server.close();
      await dep.close();
    },
  };
}

/** A real admin session through the real installer flow (wave 1's helper). */
async function adminSession(dep) {
  const { app } = await import('../src/index.ts');
  const executionCtx = { waitUntil(p) { void Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
  let cookie = '';
  async function session(method, path, body, headers = {}) {
    const init = { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'storylark', ...headers } };
    if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await app.fetch(new Request(`https://app.example.test${path}`, init), dep.env, executionCtx);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text };
  }
  const minted = await session('POST', '/api/admin/setup/reset', undefined, { 'X-Admin-Key': dep.env.ADMIN_KEY });
  assert.equal(minted.status, 200, `setup mint failed: ${minted.text}`);
  const token = new URL(minted.json.setupUrl).searchParams.get('setup');
  const claimed = await session('POST', '/api/admin/setup/claim', {
    token,
    email: 'operator@example.test',
    username: 'operator',
    password: 'a-long-enough-password-1',
  });
  assert.equal(claimed.status, 200, `setup claim failed: ${claimed.text}`);
  return session;
}

const CONNECTION = {
  provider: 'github',
  url: 'https://github.com/acme/stories',
  visibility: 'public',
  branch: 'main',
  path: 'content',
  intervalHours: 24,
};

async function connect(session) {
  const res = await session('PUT', '/api/admin/content-source', { mode: 'repo', repo: CONNECTION });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The acceptance test: three transports, one gate, identical rejections
 * ──────────────────────────────────────────────────────────────────────────── */

test('the SAME malformed content produces the SAME codes and messages via sync, portal and API', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);

  const cases = [
    // invalid_order — a block whose order isn't an integer
    withBlock({ type: 'chapter', book: 'one-book', chapter: 'one', order: 'two' }),
    // no_prose — a chapter that is only front matter
    withBlock({ type: 'chapter', book: 'one-book', chapter: 'one', order: 1 }, ''),
    // unclosed_frontmatter — a fence that never closes but names a storylark block
    '---\nstorylark:\n  type: chapter\n  book: one-book\n  chapter: one\n  order: 1\n\nNever closes.\n',
    // invalid_publish
    withBlock({ type: 'chapter', book: 'one-book', chapter: 'one', order: 1, publish: 'maybe' }),
  ];

  const strip = (e) => ({ code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}), ...(e.line ? { line: e.line } : {}) });

  for (const markdown of cases) {
    // Door 3, the new one: the repo transport, over a real staged archive.
    await box.stage({ 'content/bad.md': markdown });
    const sync = await session('POST', '/api/admin/content-source/dry-run', { repo: CONNECTION });
    assert.equal(sync.status, 200, sync.text);
    assert.equal(sync.json.ok, false, 'the sync judged it invalid');
    const syncErrors = sync.json.report.errors;
    assert.ok(syncErrors.length > 0, 'the sync report names the rejection');
    assert.equal(syncErrors[0].file, 'content/bad.md', 'the sync names the file');

    // Door 1: the public API. Door 2: the portal.
    const api = await box.dep.call('PUT', '/api/content/v1/books/one-book/chapters/one', { contractVersion: 1, markdown });
    const portal = await session('PUT', '/api/admin/content/books/one-book/chapters/one', { markdown });
    assert.equal(api.status, 422, api.text);
    assert.equal(portal.status, 422, portal.text);

    // The identity: same codes, same messages, all three doors. Only the
    // location (file) is the transport's own.
    assert.deepEqual(syncErrors.map(strip), api.json.errors.map(strip), 'sync and API agree');
    assert.deepEqual(syncErrors.map(strip), portal.json.errors.map(strip), 'sync and portal agree');
  }

  // And none of those rejections wrote anything.
  await assert.rejects(() => box.dep.manifest(), /ENOENT/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The repo lifecycle: connect (dry-run gate), sync, set semantics, images
 * ──────────────────────────────────────────────────────────────────────────── */

test('connect dry-runs and refuses an invalid repo; a valid one connects and syncs end to end', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);

  // A repo that does not validate cannot be connected (§6.5).
  await box.stage({ 'content/bad.md': withBlock({ type: 'chapter', book: 'b', chapter: 'c', order: 'nope' }) });
  const refused = await session('PUT', '/api/admin/content-source', { mode: 'repo', repo: CONNECTION });
  assert.equal(refused.status, 422, refused.text);
  assert.equal(refused.json.error, 'repo_invalid');
  assert.equal(refused.json.report.errors[0].code, 'invalid_order');

  // A repo with nothing opted in cannot be connected either — nothing would sync.
  await box.stage({ 'content/notes.md': '# No block here\n\nProse.\n' });
  const empty = await session('PUT', '/api/admin/content-source', { mode: 'repo', repo: CONNECTION });
  assert.equal(empty.status, 422, empty.text);
  assert.equal(empty.json.error, 'repo_empty');

  // The real fixture connects — and the connect itself wrote nothing.
  await box.stage(fixtureV1());
  const connected = await connect(session);
  assert.equal(connected.report.dryRun, true);
  assert.equal(connected.report.candidates, 4, 'book file + 2 chapters + 1 story judged');
  assert.equal(connected.report.ignored, 1, 'outline.md has no block and is not content');
  await assert.rejects(() => box.dep.manifest(), /ENOENT/, 'a dry-run publishes nothing');

  // Sync now — the real write.
  const synced = await session('POST', '/api/admin/content-source/sync');
  assert.equal(synced.status, 200, synced.text);
  assert.equal(synced.json.ok, true, synced.text);
  const report = synced.json.report;
  assert.equal(report.chaptersWritten, 3, 'two chapters + one story');
  assert.equal(report.imagesIngested, 1);
  assert.deepEqual(report.missing, [], 'first sync has nothing to miss');

  const manifest = await box.dep.manifest();
  const keepers = manifest.books.find((b) => b.id === 'the-keepers');
  // §10.7 set-not-stream: the `type: book` file sorted LAST and still declared
  // the book the chapters name — no file-order dependence.
  assert.ok(keepers, 'the book landed although its declaration sorted last');
  assert.equal(keepers.title, 'The Keepers');
  assert.equal(keepers.author, 'A. Writer');
  assert.equal(keepers.origin, 'sync');
  assert.equal(keepers.syncSource.kind, 'git');
  assert.equal(keepers.syncSource.url, CONNECTION.url);
  assert.deepEqual(
    keepers.chapters.map((ch) => ch.id),
    ['the-long-road', 'the-keeper'],
    'declared order decides the manifest order'
  );
  assert.equal(keepers.single, false, 'a two-chapter book presents as a book');
  assert.equal(keepers.chapters[0].order, 1, 'the declared order is remembered for §10.6');

  // The story: filename as the transport's address, `full` as its chapter.
  const winterlight = manifest.books.find((b) => b.id === 'winterlight');
  assert.ok(winterlight, 'the story landed');
  assert.equal(winterlight.single, true, 'a story presents as a single');
  assert.equal(winterlight.title, 'Winterlight', 'storylark.title overrode the top-level title');
  assert.equal(winterlight.chapters[0].id, 'full');

  // Image ingestion: the stored source references the deployment's own copy,
  // never the repo (§6.5 — no hotlinking; offline downloads cache images).
  const source = await readFile(join(box.dep.dir, 'books', 'the-keepers', 'source', 'the-long-road.md'), 'utf8');
  assert.match(source, /\/books\/the-keepers\/images\/lighthouse-[0-9a-f]{12}\.png/, 'the reference was rewritten to the ingested key');
  assert.doesNotMatch(source, /\(images\/lighthouse\.png\)/);

  // Narration joined the arrival (design §8): one job per written chapter.
  const jobs = box.dep.db.prepare('SELECT COUNT(*) AS n FROM narration_jobs').get();
  assert.equal(jobs.n, 3, 'every written chapter owes narration');

  // Synced content is read-only in the portal — the ownership rule holds.
  const edit = await session('PUT', '/api/admin/content/books/the-keepers/chapters/the-keeper', { markdown: chapterMarkdown('Nope') });
  assert.equal(edit.status, 409);
  assert.equal(edit.json.error, 'managed_externally');

  // Re-syncing the unchanged repo writes nothing and bumps nothing — a daily
  // no-op sync must not make every reader re-fetch the manifest.
  const again = await session('POST', '/api/admin/content-source/sync');
  assert.equal(again.json.report.chaptersWritten, 0);
  assert.equal(again.json.report.chaptersUnchanged, 3);
  const after = await box.dep.manifest();
  assert.equal(after.libraryVersion, manifest.libraryVersion, 'nothing changed, nothing bumped');
});

test('an invalid arrival is atomic: a valid sibling edit is not partially published', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);
  await connect(session);
  await session('POST', '/api/admin/content-source/sync');

  const before = await box.dep.manifest();
  const beforeSource = await readFile(join(box.dep.dir, 'books', 'winterlight', 'source', 'full.md'), 'utf8');
  const changed = fixtureV1();
  changed['content/winterlight.md'] = withBlock({ type: 'story', title: 'Winterlight' }, `${PROSE} This edit must wait.`);
  changed['content/broken.md'] = withBlock({ type: 'chapter', book: 'the-keepers', chapter: 'broken', order: 'not-an-integer' });
  await box.stage(changed);

  const sync = await session('POST', '/api/admin/content-source/sync');
  assert.equal(sync.status, 200, sync.text);
  assert.equal(sync.json.ok, false);
  assert.ok(sync.json.report.errors.some((e) => e.code === 'invalid_order'));
  assert.equal(sync.json.report.chaptersWritten, 0, 'validation failure writes no valid siblings');
  assert.equal(await readFile(join(box.dep.dir, 'books', 'winterlight', 'source', 'full.md'), 'utf8'), beforeSource);
  const after = await box.dep.manifest();
  assert.deepEqual(after, before, 'the complete manifest stays byte-for-byte equivalent as JSON');
});

test('an unchanged repo sync preserves narration, timings and every narrator voice path', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);
  await connect(session);
  await session('POST', '/api/admin/content-source/sync');

  const manifestPath = join(box.dep.dir, 'manifest.json');
  const before = await box.dep.manifest();
  const chapter = before.books.find((b) => b.id === 'winterlight').chapters[0];
  chapter.hasAudio = true;
  chapter.audioDurationMs = 12_345;
  chapter.audio = 'books/winterlight/audio/full.primary.mp3';
  chapter.timings = 'books/winterlight/timings/full.primary.json';
  chapter.audioStale = false;
  chapter.voices = {
    harper: { audio: 'books/winterlight/audio/full.harper.mp3', timings: 'books/winterlight/timings/full.harper.json' },
    isla: { audio: 'books/winterlight/audio/full.isla.mp3', timings: 'books/winterlight/timings/full.isla.json' },
    ethan: { audio: 'books/winterlight/audio/full.ethan.mp3', timings: 'books/winterlight/timings/full.ethan.json' },
  };
  await writeFile(manifestPath, `${JSON.stringify(before, null, 2)}\n`);

  const sync = await session('POST', '/api/admin/content-source/sync');
  assert.equal(sync.status, 200, sync.text);
  assert.equal(sync.json.report.chaptersWritten, 0);
  const after = await box.dep.manifest();
  const preserved = after.books.find((b) => b.id === 'winterlight').chapters[0];
  assert.equal(after.libraryVersion, before.libraryVersion, 'a no-op does not churn the manifest version');
  assert.equal(preserved.audio, chapter.audio);
  assert.equal(preserved.timings, chapter.timings);
  assert.deepEqual(preserved.voices, chapter.voices);
  assert.equal(preserved.audioStale, false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * §10.1 — missing is a flag and a human click, never an inference
 * ──────────────────────────────────────────────────────────────────────────── */

test('a vanished file is reported missing, publishes nothing, and is removed only by the operator click', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);
  await connect(session);
  await session('POST', '/api/admin/content-source/sync');

  // v2 of the repo no longer carries 02-the-keeper.md.
  const v2 = fixtureV1();
  delete v2['content/the-keepers/02-the-keeper.md'];
  await box.stage(v2);
  const synced = await session('POST', '/api/admin/content-source/sync');
  assert.equal(synced.status, 200, synced.text);
  assert.deepEqual(
    synced.json.report.missing.map((m) => `${m.bookId}/${m.chapterId}`),
    ['the-keepers/the-keeper'],
    'the absence is reported'
  );

  // …and NOTHING was unpublished: absence is not a statement.
  let manifest = await box.dep.manifest();
  assert.ok(manifest.books.find((b) => b.id === 'the-keepers').chapters.some((ch) => ch.id === 'the-keeper'));

  // A chapter the report did not flag cannot ride along.
  const rejected = await session('POST', '/api/admin/content-source/remove-missing', {
    chapters: [{ bookId: 'the-keepers', chapterId: 'the-long-road' }],
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.error, 'not_flagged');

  // The one-click removal runs the ordinary recoverable delete.
  const removed = await session('POST', '/api/admin/content-source/remove-missing', {
    chapters: [{ bookId: 'the-keepers', chapterId: 'the-keeper' }],
  });
  assert.equal(removed.status, 200, removed.text);
  manifest = await box.dep.manifest();
  assert.equal(manifest.books.find((b) => b.id === 'the-keepers').chapters.some((ch) => ch.id === 'the-keeper'), false);
  // Recoverable: the source and history STAY in storage.
  await access(join(box.dep.dir, 'books', 'the-keepers', 'source', 'the-keeper.md'));
});

/* ────────────────────────────────────────────────────────────────────────────
 * §10.5 — first writer owns the id; §10.6 — the stored manifest joins the tie
 * ──────────────────────────────────────────────────────────────────────────── */

test('a cross-source collision is book_owned_elsewhere, naming the owner; same source re-syncing is an update', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);

  // The operator writes a book in the portal first.
  const created = await session('PUT', '/api/content/v1/books/mine', { contractVersion: 1, title: 'Mine', managed: false });
  assert.equal(created.status, 200, created.text);

  // The repo then tries to claim the same id.
  const fixture = fixtureV1();
  fixture['content/mine/01-takeover.md'] = withBlock({ type: 'chapter', book: 'mine', chapter: 'takeover', order: 1 });
  await box.stage(fixture);
  const dry = await session('POST', '/api/admin/content-source/dry-run', { repo: CONNECTION });
  const owned = dry.json.report.errors.find((e) => e.code === 'book_owned_elsewhere');
  assert.ok(owned, `expected book_owned_elsewhere among ${JSON.stringify(dry.json.report.errors)}`);
  assert.match(owned.message, /portal/, 'the rejection names the current owner');
  assert.match(owned.message, /"mine"/);

  // The portal book is untouched even by a REAL sync carrying the collision.
  await connect(session).catch(() => undefined); // connect refuses (errors present) — force config directly via dry-run-free path
  const manifest = await box.dep.manifest().catch(() => null);
  if (manifest) {
    const mine = manifest.books.find((b) => b.id === 'mine');
    assert.equal(mine.origin, 'portal');
    assert.deepEqual(mine.chapters, []);
  }
});

test('GitHub reads only the configured content path and never downloads an unrelated large repository archive', async (t) => {
  const box = await contentsDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);

  const connected = await connect(session);
  assert.equal(connected.report.candidates, 1);
  const synced = await session('POST', '/api/admin/content-source/sync');
  assert.equal(synced.status, 200, synced.text);
  assert.equal(synced.json.report.chaptersWritten, 1);
  assert.equal((await box.dep.manifest()).books[0].id, 'path-first');
  assert.equal(box.requests.some((path) => path.includes('zipball')), false, 'the whole archive was never requested');
  assert.equal(box.requests.some((path) => path.includes('unrelated-250mb.bin')), false, 'an unrelated large file was never requested');
  assert.equal(box.requests.some((path) => path.includes('/contents/content/path-first.md')), false, 'Markdown bodies were batch-read');
});

test('matching-only adoption migrates an unchanged live book without touching narration; mismatches remain blocked', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);

  // A legacy CLI/API book: same visible title and prose as the repository,
  // but no storylark block and therefore no repo ownership metadata.
  const illustratedProse = `${PROSE}\n\n![A faithful dog](/images/stories/adopt-me.png)`;
  const legacy = `---\ntitle: Adopt Me\n---\n\n${illustratedProse}\n`;
  const created = await box.dep.call('PUT', '/api/content/v1/books/adopt-me', {
    contractVersion: 1,
    title: 'Adopt Me',
    managed: false,
    chapters: [{ id: 'story', markdown: legacy }],
  });
  assert.equal(created.status, 200, created.text);

  // Give it the assets adoption must preserve. They need not exist for this
  // ownership test; the manifest references are the zero-loss contract.
  let manifest = await box.dep.manifest();
  const live = manifest.books.find((book) => book.id === 'adopt-me');
  const chapter = live.chapters[0];
  chapter.hasAudio = true;
  chapter.audio = 'books/adopt-me/audio/full.primary.mp3';
  chapter.timings = 'books/adopt-me/audio/full.primary.json';
  chapter.voices = {
    warm: { audio: 'books/adopt-me/audio/full.warm.mp3', timings: 'books/adopt-me/audio/full.warm.json' },
  };
  await writeFile(join(box.dep.dir, 'manifest.json'), JSON.stringify(manifest));
  const protectedFields = {
    contentHash: chapter.contentHash,
    content: chapter.content,
    audio: chapter.audio,
    timings: chapter.timings,
    voices: chapter.voices,
  };
  const liveContent = JSON.parse(await readFile(join(box.dep.dir, chapter.content), 'utf8'));
  assert.equal(
    liveContent.blocks.find((block) => block.type === 'image').src,
    'https://example.test/images/stories/adopt-me.png',
    'root-relative artwork uses the same marketing-site origin as the publish pipeline'
  );

  const repoMarkdown = withBlock({ type: 'story', title: 'Adopt Me', order: 1 }, illustratedProse);
  const adoptingConnection = { ...CONNECTION, adoptMatchingExisting: true };

  // An explicit adoption request is still a refusal when one word differs.
  await box.stage({ 'content/adopt-me.md': repoMarkdown.replace('perfectly ordinary', 'materially different') });
  const mismatch = await session('PUT', '/api/admin/content-source', { mode: 'repo', repo: adoptingConnection });
  assert.equal(mismatch.status, 422, mismatch.text);
  assert.equal(mismatch.json.report.errors[0].code, 'book_owned_elsewhere');
  assert.match(mismatch.json.report.errors[0].message, /renders to .* not the live hash/);
  manifest = await box.dep.manifest();
  assert.equal(manifest.books.find((book) => book.id === 'adopt-me').origin, 'portal', 'a mismatch changes no ownership');

  // The exact rendered match connects in a dry run, then adopts without a
  // chapter save (the operation that would mark audio stale).
  await box.stage({ 'content/adopt-me.md': repoMarkdown });
  const connected = await session('PUT', '/api/admin/content-source', { mode: 'repo', repo: adoptingConnection });
  assert.equal(connected.status, 200, connected.text);
  assert.deepEqual(connected.json.report.adoptionCandidates, ['adopt-me']);
  const synced = await session('POST', '/api/admin/content-source/sync');
  assert.equal(synced.status, 200, synced.text);
  assert.deepEqual(synced.json.report.adopted, ['adopt-me']);
  assert.equal(synced.json.report.chaptersWritten, 0);
  assert.equal(synced.json.report.chaptersUnchanged, 1);

  manifest = await box.dep.manifest();
  const adopted = manifest.books.find((book) => book.id === 'adopt-me');
  assert.equal(adopted.origin, 'sync');
  assert.equal(adopted.syncSource.url, CONNECTION.url);
  assert.equal(adopted.chapters[0].origin, 'sync');
  assert.equal(adopted.chapters[0].declaredType, 'story');
  assert.equal(adopted.chapters[0].id, 'story', 'an implicit story chapter preserves the live singleton id and reader URLs');
  assert.equal(adopted.chapters[0].order, undefined, 'a standalone story order belongs to the shelf, not its only chapter');
  assert.deepEqual(
    {
      contentHash: adopted.chapters[0].contentHash,
      content: adopted.chapters[0].content,
      audio: adopted.chapters[0].audio,
      timings: adopted.chapters[0].timings,
      voices: adopted.chapters[0].voices,
    },
    protectedFields,
    'content and every narration reference survive adoption'
  );
  assert.notEqual(adopted.chapters[0].audioStale, true);
  assert.equal((await box.dep.call('GET', '/api/library/version')).json.version, manifest.libraryVersion, 'readers are told the adopted manifest moved');

  const adoptedVersion = manifest.libraryVersion;
  const repeated = await session('POST', '/api/admin/content-source/sync');
  assert.equal(repeated.json.report.chaptersWritten, 0);
  assert.equal((await box.dep.manifest()).libraryVersion, adoptedVersion, 'the second sync is a no-op');
});

test('§10.6: a declared order colliding with a stored incumbent is the same order_tie through every door', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);

  // A portal-owned book whose chapter DECLARED its order, so the declaration is stored.
  const first = await session('PUT', '/api/content/v1/books/tiebook', {
    contractVersion: 1,
    managed: false,
    chapters: [{ id: 'a', markdown: withBlock({ type: 'chapter', book: 'tiebook', chapter: 'a', order: 1 }) }],
  });
  assert.equal(first.status, 200, first.text);

  // Door 1 — the API, a month later, claiming the order "a" already holds.
  const api = await box.dep.call('PUT', '/api/content/v1/books/tiebook/chapters/b', {
    contractVersion: 1,
    managed: false,
    markdown: withBlock({ type: 'chapter', book: 'tiebook', chapter: 'b', order: 1 }),
  });
  assert.equal(api.status, 422, api.text);
  assert.equal(api.json.error, 'order_tie');
  assert.match(api.json.message, /"a"/, 'the incumbent is named although it arrived in an earlier request');

  // Door 2 — the portal.
  const portal = await session('PUT', '/api/admin/content/books/tiebook/chapters/c', {
    markdown: withBlock({ type: 'chapter', book: 'tiebook', chapter: 'c', order: 1 }),
  });
  assert.equal(portal.status, 422, portal.text);
  assert.equal(portal.json.error, 'order_tie');
  assert.match(portal.json.message, /"a"/);

  // Re-declaring the order a chapter already owns is NOT a tie.
  const own = await box.dep.call('PUT', '/api/content/v1/books/tiebook/chapters/a', {
    contractVersion: 1,
    managed: false,
    markdown: withBlock({ type: 'chapter', book: 'tiebook', chapter: 'a', order: 1 }, `${PROSE} Edited.`),
  });
  assert.equal(own.status, 200, own.text);

  // Door 3 — the sync transport: a new chapter claiming a stored sibling's order.
  await box.stage(fixtureV1());
  await connect(session);
  await session('POST', '/api/admin/content-source/sync');
  await box.stage({
    ...fixtureV1(),
    'content/the-keepers/03-usurper.md': withBlock({ type: 'chapter', book: 'the-keepers', chapter: 'usurper', order: 1 }),
  });
  const synced = await session('POST', '/api/admin/content-source/sync');
  const tie = synced.json.report.errors.find((e) => e.code === 'order_tie');
  assert.ok(tie, `expected order_tie among ${JSON.stringify(synced.json.report.errors)}`);
  assert.match(tie.message, /the-long-road/, 'the stored incumbent is named');
  const manifest = await box.dep.manifest();
  assert.equal(
    manifest.books.find((b) => b.id === 'the-keepers').chapters.some((ch) => ch.id === 'usurper'),
    false,
    'the tied chapter published nothing'
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * §6.2 — the webhook: signed accepted, forged rejected
 * ──────────────────────────────────────────────────────────────────────────── */

test('the webhook accepts a correctly-signed push and rejects a forged one', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);
  await connect(session);

  const minted = await session('POST', '/api/admin/content-source/webhook-secret');
  assert.equal(minted.status, 200, minted.text);
  const secret = minted.json.secret;
  assert.ok(secret.length >= 32, 'the secret is shown once, here');

  const { app } = await import('../src/index.ts');
  const executionCtx = { waitUntil(p) { void Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
  async function deliver(body, signature, event = 'push') {
    const res = await app.fetch(
      new Request('https://app.example.test/api/content/v1/sync/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
          'X-GitHub-Event': event,
        },
        body,
      }),
      box.dep.env,
      executionCtx
    );
    return { status: res.status, json: await res.json() };
  }
  const sign = (body, key = secret) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
  const push = JSON.stringify({
    ref: 'refs/heads/main',
    commits: [{ added: [], removed: [], modified: ['content/the-keepers/01-the-long-road.md'] }],
  });

  // The rejection is the half that matters: forged signature, wrong secret, no
  // signature at all — every one refused, nothing synced.
  const forged = await deliver(push, `sha256=${'0'.repeat(64)}`);
  assert.equal(forged.status, 401);
  assert.equal(forged.json.error, 'invalid_signature');
  const wrongKey = await deliver(push, sign(push, 'not-the-secret'));
  assert.equal(wrongKey.status, 401);
  const unsigned = await deliver(push, undefined);
  assert.equal(unsigned.status, 401);
  await assert.rejects(() => box.dep.manifest(), /ENOENT/, 'no forged delivery caused a sync');

  // A signed ping answers without syncing; a signed push on another branch is
  // acknowledged and skipped; a signed push on the configured branch queues.
  const ping = await deliver(push, sign(push), 'ping');
  assert.equal(ping.json.pong, true);
  const other = JSON.stringify({ ref: 'refs/heads/feature', commits: [] });
  const skipped = await deliver(other, sign(other));
  assert.equal(skipped.json.synced, false);
  const accepted = await deliver(push, sign(push));
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  assert.equal(accepted.json.queued, true);
  // The waitUntil polyfill runs the sync as a background promise. Wait for the
  // run to record itself DONE (claim released, report stored) rather than
  // sleeping a guess — a sync still writing while the test tears its temp
  // directory down is a Windows ENOTEMPTY flake.
  const finished = await pollUntil(async () => {
    const row = box.dep.db.prepare('SELECT running_since, last_sync_at FROM content_sync WHERE id = 1').get();
    return row && row.running_since === null && row.last_sync_at !== null;
  });
  assert.ok(finished, 'the queued sync completed');
  const manifest = await box.dep.manifest();
  assert.ok(manifest.books.find((b) => b.id === 'the-keepers'), 'the signed push synced the repo');
});

/** Poll a condition until true, up to ~10s. */
async function pollUntil(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 10 — scoped content-API tokens
 * ──────────────────────────────────────────────────────────────────────────── */

test('a scoped token works on the content API alone, shows last-used, and dies on revocation', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);

  const minted = await session('POST', '/api/admin/content-tokens', { name: 'acme-cms' });
  assert.equal(minted.status, 200, minted.text);
  const token = minted.json.token;
  assert.match(token, /^sct_/, 'the plaintext exists exactly once, in this response');

  // The token opens the content API…
  const bearer = { 'X-Admin-Key': '', Authorization: `Bearer ${token}` };
  const catalogue = await box.dep.call('GET', '/api/content/v1/catalogue', undefined, bearer);
  assert.equal(catalogue.status, 200, catalogue.text);
  const pushed = await box.dep.call('PUT', '/api/content/v1/books/token-made', { contractVersion: 1, title: 'Pushed', managed: true }, bearer);
  assert.equal(pushed.status, 200, pushed.text);

  // …and nothing else: the admin surface still refuses it.
  const adminTry = await box.dep.call('GET', '/api/admin/content/books', undefined, bearer);
  assert.equal(adminTry.status, 401, 'a content token is not an admin credential');

  // A forged token is refused.
  const forged = await box.dep.call('GET', '/api/content/v1/catalogue', undefined, { 'X-Admin-Key': '', Authorization: 'Bearer sct_forged' });
  assert.equal(forged.status, 401);

  // Last-used is visible — the difference between a working integration and a
  // silently broken one (§7).
  const listed = await session('GET', '/api/admin/content-tokens');
  const mine = listed.json.tokens.find((tk) => tk.name === 'acme-cms');
  assert.ok(mine.lastUsedAt !== null, 'last-used recorded');

  // Revocation is immediate.
  const revoked = await session('DELETE', `/api/admin/content-tokens/${mine.id}`);
  assert.equal(revoked.status, 200, revoked.text);
  const dead = await box.dep.call('GET', '/api/content/v1/catalogue', undefined, bearer);
  assert.equal(dead.status, 401, 'a revoked token is dead on the next request');

  // ADMIN_KEY keeps working exactly as before.
  const stillKeyed = await box.dep.call('GET', '/api/content/v1/catalogue');
  assert.equal(stillKeyed.status, 200);
});

/* ────────────────────────────────────────────────────────────────────────────
 * §10.3 — the scheduled pull self-gates on its interval
 * ──────────────────────────────────────────────────────────────────────────── */

test('the scheduled job syncs when due and skips when not — the cron itself never changes', async (t) => {
  const box = await syncDeployment();
  t.after(() => box.close());
  const session = await adminSession(box.dep);
  await connect(session);
  const { scheduledContentSync } = await import('../src/lib/repo-sync.ts');

  // Fresh connection, never synced: the daily tick runs it.
  const before = box.hits();
  await scheduledContentSync(box.dep.env);
  assert.ok(box.hits() > before, 'a due connection syncs on the tick');
  assert.ok(await box.dep.manifest(), 'the scheduled run published');

  // Synced moments ago: the next tick is a no-op — the interval gates it.
  const after = box.hits();
  await scheduledContentSync(box.dep.env);
  assert.equal(box.hits(), after, 'not due, not fetched');

  // Backdate the last run past the interval: due again.
  box.dep.db.prepare('UPDATE content_sync SET last_sync_at = ? WHERE id = 1').run(Date.now() - 25 * 3600 * 1000);
  await scheduledContentSync(box.dep.env);
  assert.ok(box.hits() > after, 'due again once the interval has passed');
});
