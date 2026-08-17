// The content contract — ONE validator, three transports (content-management
// rework wave 1, AB#7420).
//
// Three things are proven here, in increasing order of realness:
//
//   1. The validator itself (`storylark-contracts/content`): every stable error
//      code in the vocabulary is real and produced, order ties are an error,
//      required fields are required, `publish: false` withholds, and a file
//      without a `storylark:` block is not repo content.
//   2. The frontmatter BOUNDARY the validator reads is byte-identical to both
//      existing markdown implementations (pipeline md.mjs, worker md.ts) —
//      the same parity discipline md-parity.test.mjs applies to those two.
//      This module must never become a third divergent opinion of where a
//      file's front matter ends.
//   3. Against the REAL app over real requests (same harness as
//      content-api.test.mjs): the SAME bad input produces the SAME code and
//      the SAME message through the portal's session-gated route and the
//      public API's keyed route. That identical-error property is the test of
//      whether the one-gate architecture is real — if any transport grew its
//      own opinion, this fails.
//
// Plus the portal's book lifecycle: create and delete ride the PUBLIC content
// API authenticated by a real admin session (minted through the real installer
// flow), not by X-Admin-Key — one implementation, two credentials.
//
//   node --import tsx/esm --test packages/worker/test/content-contract.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CONTENT_ERROR_CODES,
  CONTENT_ID_RE,
  PUBLISH_WITHHELD_MESSAGE,
  bookOwnedElsewhereError,
  readStorylarkBlock,
  splitFrontmatter,
  unknownBookError,
  validateBookCandidate,
  validateChapterCandidate,
} from 'storylark-contracts/content';
import * as nodeMd from '../../pipeline/lib/md.mjs';
import * as workerMd from '../src/lib/md.ts';
import { testDeployment, chapterMarkdown } from './sqlite-env.mjs';

const PROSE = 'A paragraph of perfectly ordinary prose, long enough to be a chapter.';

/** A chapter file carrying a `storylark:` block, plus the customer's own untouched fields. */
function withBlock(fields, body = PROSE) {
  const block = Object.entries(fields)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  return `---\ntitle: Their Own Title\nstoryNumber: 7\nstorylark:\n${block}\n---\n${body ? `\n${body}\n` : ''}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. The frontmatter boundary agrees with BOTH existing implementations
 * ──────────────────────────────────────────────────────────────────────────── */

test('splitFrontmatter finds the same body both markdown implementations do', () => {
  const corpus = [
    '',
    'No front matter at all.',
    '---\ntitle: A Title\nlabel: Read\n---\n',
    '---\ntitle: A Title\n---\n\nThe body starts here.',
    '---\ntitle: "Quoted: Title"\nlabel: \'Read\'\n---\n\nBody.',
    '﻿---\ntitle: With BOM\n---\n\nBody.',
    '---\r\ntitle: CRLF\r\n---\r\n\r\nFirst.\r\n\r\nSecond.',
    'Before.\n\n---\n\nAfter.', // a scene break is NOT front matter
    withBlock({ type: 'chapter', book: 'a-book', chapter: 'one', order: 1 }),
  ];
  for (const src of corpus) {
    const label = JSON.stringify(src.slice(0, 30));
    assert.equal(splitFrontmatter(src).body, nodeMd.readFrontmatter(src).body, `${label} vs pipeline`);
    assert.equal(splitFrontmatter(src).body, workerMd.readFrontmatter(src).body, `${label} vs worker`);
  }
});

test('the storylark: block is invisible to the flat frontmatter readers — additive by construction', () => {
  const src = withBlock({ type: 'chapter', book: 'a-book', chapter: 'one', order: 1 });
  for (const impl of [nodeMd, workerMd]) {
    const { data } = impl.readFrontmatter(src);
    assert.equal(data.title, 'Their Own Title', 'the customer’s own fields still read');
    assert.equal(data.storyNumber, 7);
    assert.equal(data.storylark, undefined, 'the nested block never leaks into the flat view');
    assert.equal(data.type, undefined, 'nor do its fields');
  }
  const block = readStorylarkBlock(src);
  assert.equal(block.present, true);
  assert.deepEqual(block.fields, { type: 'chapter', book: 'a-book', chapter: 'one', order: 1 });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. The validator — every code, ties, defaults, the no-block rule
 * ──────────────────────────────────────────────────────────────────────────── */

test('a conforming strict chapter normalises with the spec defaults', () => {
  const result = validateChapterCandidate({
    file: 'stories/going-east.md',
    markdown: withBlock({ type: 'chapter', book: 'the-voyage-home', chapter: 'going-east', order: 3 }),
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.record, {
    type: 'chapter',
    book: 'the-voyage-home',
    chapter: 'going-east',
    order: 3,
    declaredOrder: 3,
    publish: true, // default, per spec — normalisation, not repair
    title: undefined,
    cover: undefined,
    contractVersion: 1, // default, per spec
    declared: true,
  });
});

test('every stable error code in the vocabulary is real, with a message and a location', () => {
  const chapterBase = { type: 'chapter', book: 'a-book', chapter: 'one', order: 1 };
  const cases = [
    ['empty_chapter', { markdown: '' }],
    ['too_large', { markdown: 'x'.repeat(2_000_001) }],
    ['unclosed_frontmatter', { markdown: '---\ntitle: Broken\n\nNo closing fence.\n' }],
    ['no_prose', { markdown: '---\ntitle: Only Front Matter\n---\n' }],
    ['missing_storylark_block', { markdown: chapterMarkdown('Legacy'), opts: { requireBlock: true } }],
    ['invalid_storylark_block', { markdown: '---\nstorylark: chapter\n---\n\nProse.\n' }],
    ['missing_field', { markdown: withBlock({ type: 'chapter' }) }],
    ['unknown_type', { markdown: withBlock({ type: 'novella' }) }],
    ['type_mismatch', { markdown: withBlock({ type: 'book' }, PROSE) }],
    ['invalid_id', { markdown: withBlock({ ...chapterBase, book: 'Not An Id' }) }],
    ['id_mismatch', { markdown: withBlock(chapterBase), candidate: { bookId: 'another-book', chapterId: 'one' } }],
    ['invalid_order', { markdown: withBlock({ ...chapterBase, order: 'two' }) }],
    ['invalid_publish', { markdown: withBlock({ ...chapterBase, publish: 'maybe' }) }],
    ['invalid_title', { markdown: withBlock({ ...chapterBase, title: 123 }) }],
    ['invalid_cover', { markdown: withBlock({ ...chapterBase, cover: 'https://cdn.example.com/a.png' }) }],
    ['invalid_contract_version', { markdown: withBlock({ ...chapterBase, contractVersion: 0 }) }],
    ['unsupported_contract_version', { markdown: withBlock({ ...chapterBase, contractVersion: 99 }) }],
  ];

  const produced = new Set();
  for (const [code, { markdown, candidate = {}, opts }] of cases) {
    const result = validateChapterCandidate({ file: 'their-repo/file.md', markdown, ...candidate }, opts);
    assert.equal(result.ok, false, `${code}: expected a rejection`);
    const hit = result.errors.find((e) => e.code === code);
    assert.ok(hit, `${code}: expected among [${result.errors.map((e) => e.code).join(', ')}]`);
    assert.ok(hit.message.length > 10, `${code}: carries a human message`);
    assert.equal(hit.file, 'their-repo/file.md', `${code}: carries the file`);
    assert.ok(typeof hit.line === 'number' || code === 'order_tie', `${code}: carries a line`);
    for (const e of result.errors) produced.add(e.code);
  }

  // order_tie lives between chapters, so it is produced by the book-level call.
  const tie = validateBookCandidate({
    bookId: 'a-book',
    chapters: [
      { chapterId: 'one', file: 'a/one.md', markdown: withBlock({ type: 'chapter', book: 'a-book', chapter: 'one', order: 2 }) },
      { chapterId: 'two', file: 'a/two.md', markdown: withBlock({ type: 'chapter', book: 'a-book', chapter: 'two', order: 2 }) },
    ],
  });
  assert.equal(tie.ok, false);
  const tieError = tie.errors.find((e) => e.code === 'order_tie');
  assert.ok(tieError, 'two chapters claiming order 2 is an error, never silently resolved');
  assert.match(tieError.message, /a\/one\.md/, 'the tie names both claimants');
  assert.match(tieError.message, /a\/two\.md/);
  produced.add('order_tie');

  // The two manifest-context codes (wave 2 — design §10.5 / §10.7) come from
  // the contract's error builders, called by whichever transport holds the
  // library state. Same codes, same sentences, whichever door.
  const unknown = unknownBookError('the-missing-book', { file: 'their-repo/ch.md' });
  assert.equal(unknown.code, 'unknown_book');
  assert.match(unknown.message, /the-missing-book/, 'names the missing book');
  assert.equal(unknown.file, 'their-repo/ch.md');
  produced.add(unknown.code);

  const owned = bookOwnedElsewhereError('taken-book', { origin: 'sync', syncSource: { kind: 'git', url: 'https://github.com/a/b', ref: 'main' } });
  assert.equal(owned.code, 'book_owned_elsewhere');
  assert.match(owned.message, /https:\/\/github\.com\/a\/b/, 'names the current owner');
  produced.add(owned.code);

  // The vocabulary and the implementation are the same set — no dead codes, no
  // undeclared ones.
  assert.deepEqual([...produced].sort(), [...CONTENT_ERROR_CODES].sort());
});

test('order: gaps are fine, ties are fatal, integers only', () => {
  const gaps = validateBookCandidate({
    bookId: 'a-book',
    chapters: [
      { chapterId: 'one', markdown: withBlock({ type: 'chapter', book: 'a-book', chapter: 'one', order: 1 }) },
      { chapterId: 'five', markdown: withBlock({ type: 'chapter', book: 'a-book', chapter: 'five', order: 5 }) },
      { chapterId: 'nine', markdown: withBlock({ type: 'chapter', book: 'a-book', chapter: 'nine', order: 9 }) },
    ],
  });
  assert.equal(gaps.ok, true, JSON.stringify(gaps.errors));

  const fractional = validateChapterCandidate({ markdown: withBlock({ type: 'chapter', book: 'b', chapter: 'c', order: 1.5 }) });
  assert.equal(fractional.ok, false);
  assert.equal(fractional.errors[0].code, 'invalid_order');
});

test('missing required fields are errors, never guesses — and the transport’s identity satisfies them honestly', () => {
  // Alone in a repo, `type: chapter` needs all three.
  const bare = validateChapterCandidate({ markdown: withBlock({ type: 'chapter' }) });
  assert.equal(bare.ok, false);
  assert.deepEqual(
    bare.errors.map((e) => e.field).sort(),
    ['book', 'chapter', 'order'],
    'each missing required field is named'
  );

  // Arriving through a transport that states identity (URL segments, array
  // position), the same file is satisfied — that is layout, not inference.
  const addressed = validateChapterCandidate({
    bookId: 'a-book',
    chapterId: 'one',
    order: 4,
    markdown: withBlock({ type: 'chapter' }),
  });
  assert.equal(addressed.ok, true, JSON.stringify(addressed.errors));
  assert.equal(addressed.record.book, 'a-book');
  assert.equal(addressed.record.order, 4);
  assert.equal(addressed.record.declaredOrder, undefined, 'a transport position is not a declared order');
});

test('the governing rule: a file without a storylark: block is not StoryLark content (repo mode)', () => {
  // The exact file a customer's site already has — valid Astro/Hugo content,
  // nothing to do with StoryLark.
  const theirFile = '---\ntitle: The Voyage Home, Going East\nstoryNumber: 1\ndraft: false\n---\n\nTheir prose.\n';
  const repo = validateChapterCandidate({ file: 'src/content/going-east.md', markdown: theirFile }, { requireBlock: true });
  assert.equal(repo.ok, false);
  assert.equal(repo.errors[0].code, 'missing_storylark_block');
  assert.match(repo.errors[0].message, /not StoryLark content/);

  // The SAME file through the portal or API — where the request states the
  // identity — is grandfathered, which is what keeps both live deployments'
  // entire catalogues valid.
  const portal = validateChapterCandidate({ bookId: 'a-book', chapterId: 'one', markdown: theirFile });
  assert.equal(portal.ok, true);
  assert.equal(portal.record.declared, false);
});

test('publish: false is a valid record that says so; story and book types carry their own rules', () => {
  const withheld = validateChapterCandidate({
    markdown: withBlock({ type: 'chapter', book: 'a-book', chapter: 'one', order: 1, publish: false }),
  });
  assert.equal(withheld.ok, true);
  assert.equal(withheld.record.publish, false);

  // A story is a book with exactly one chapter in one file — ids optional.
  const story = validateChapterCandidate({ markdown: withBlock({ type: 'story' }) });
  assert.equal(story.ok, true, JSON.stringify(story.errors));
  assert.equal(story.record.type, 'story');

  // A book file is metadata only: no prose required, prose refused.
  const bookMeta = validateChapterCandidate({ markdown: withBlock({ type: 'book', title: 'The Voyage Home' }, '') });
  assert.equal(bookMeta.ok, true, JSON.stringify(bookMeta.errors));
  assert.equal(bookMeta.record.title, 'The Voyage Home');

  // Determinism: the same input gives the same errors, twice.
  const bad = { markdown: withBlock({ type: 'chapter', order: 'two' }) };
  assert.deepEqual(validateChapterCandidate(bad).errors, validateChapterCandidate(bad).errors);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. The real app: same input, same errors, whichever door — and the portal's
 *    book lifecycle over the public API with a session
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A real admin session, minted through the real installer flow: setup token
 * from ADMIN_KEY, claimed into an operator account, cookie captured. Requests
 * made with the returned function carry the session and the CSRF header and NO
 * admin key — the portal's exact posture.
 */
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

test('the SAME bad input produces the SAME code and message through the portal door and the API door', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());
  const session = await adminSession(dep);

  const cases = [
    withBlock({ type: 'chapter', book: 'one-book', chapter: 'one', order: 'two' }), // invalid_order
    withBlock({ type: 'chapter', book: 'someone-elses-book', chapter: 'one', order: 1 }), // id_mismatch
    '---\ntitle: Broken\n\nNever closes.\n', // unclosed_frontmatter
    '---\ntitle: Only Front Matter\n---\n', // no_prose
  ];

  for (const markdown of cases) {
    // Door 1: the public content API, X-Admin-Key.
    const api = await dep.call('PUT', '/api/content/v1/books/one-book/chapters/one', { contractVersion: 1, markdown });
    // Door 2: the portal's admin route, session cookie.
    const portal = await session('PUT', '/api/admin/content/books/one-book/chapters/one', { markdown });

    assert.equal(api.status, 422, api.text);
    assert.equal(portal.status, 422, portal.text);
    assert.equal(portal.json.error, api.json.error, 'same failure, same stable code, whichever door');
    // The envelopes differ (the API prefixes the book/chapter, states its
    // contractVersion); the STRUCTURED list is the vocabulary and must be
    // identical modulo the location the transport could supply.
    const strip = (e) => ({ code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}), ...(e.line ? { line: e.line } : {}) });
    assert.deepEqual(portal.json.errors.map(strip), api.json.errors.map((e) => strip({ ...e, file: undefined })), 'same errors, same messages');
  }

  // And nothing was written by any of those rejections.
  await assert.rejects(() => dep.manifest(), /ENOENT/);
});

test('publish: false is withheld identically through both doors — accepted, valid, not published', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());
  const session = await adminSession(dep);
  const markdown = withBlock({ type: 'chapter', book: 'quiet-book', chapter: 'not-yet', order: 1, publish: false });

  // managed:false so the book stays portal-writable — otherwise the portal
  // door would (correctly) refuse with managed_externally before the withhold
  // could even be compared.
  const api = await dep.call('PUT', '/api/content/v1/books/quiet-book/chapters/not-yet', { contractVersion: 1, managed: false, markdown });
  assert.equal(api.status, 200, api.text);
  const chapter = api.json.results[0].chapters[0];
  assert.equal(chapter.withheld, true);
  assert.equal(chapter.message, PUBLISH_WITHHELD_MESSAGE);
  assert.equal(api.json.summary.chaptersWithheld, 1);
  assert.equal(api.json.summary.chaptersSucceeded, 0, 'withheld is not "published", so nothing announces');
  assert.equal(api.json.narration.queued, 0, 'no text published, no narration owed');

  const portal = await session('PUT', '/api/admin/content/books/quiet-book/chapters/not-yet', { markdown });
  assert.equal(portal.status, 200, portal.text);
  assert.equal(portal.json.withheld, true);
  assert.equal(portal.json.message, PUBLISH_WITHHELD_MESSAGE, 'the same sentence, whichever door');

  // The book's metadata entry may exist; the withheld chapter must not.
  const manifest = await dep.manifest();
  const book = manifest.books.find((b) => b.id === 'quiet-book');
  assert.equal((book?.chapters ?? []).length, 0, 'a withheld chapter is not in the library');
});

test('the portal book lifecycle rides the PUBLIC API routes with a session instead of a key', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());
  const session = await adminSession(dep);

  // CREATE — exactly the request ContentSection.tsx sends: the public route,
  // session-authenticated, managed:false so the book stays portal-owned.
  const created = await session('PUT', '/api/content/v1/books/portal-made', {
    contractVersion: 1,
    title: 'Written Here',
    author: 'The Operator',
    description: 'Made in the portal, over the public contract.',
    managed: false,
  });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.results[0].created, true);

  let manifest = await dep.manifest();
  let book = manifest.books.find((b) => b.id === 'portal-made');
  assert.equal(book.title, 'Written Here');
  assert.equal(book.author, 'The Operator');
  assert.equal(book.origin, 'portal', 'managed:false makes it portal-owned and editable');
  assert.equal(book.syncSource, undefined);
  assert.deepEqual(book.chapters, [], 'a new book starts empty; chapters come through the editor');

  // The first chapter lands through the portal's own editor route, same session.
  const saved = await session('PUT', '/api/admin/content/books/portal-made/chapters/one', {
    markdown: chapterMarkdown('Chapter One'),
    correction: false,
  });
  assert.equal(saved.status, 200, saved.text);
  manifest = await dep.manifest();
  book = manifest.books.find((b) => b.id === 'portal-made');
  assert.equal(book.chapters.length, 1);
  assert.equal(book.origin, 'portal', 'the chapter save did not re-label the book');

  // DELETE — the same public route the API caller uses, typed-confirmation
  // being purely portal rendering. The manifest entry goes…
  const deleted = await session('DELETE', '/api/content/v1/books/portal-made');
  assert.equal(deleted.status, 200, deleted.text);
  manifest = await dep.manifest();
  assert.equal(manifest.books.find((b) => b.id === 'portal-made'), undefined);

  // …and the source and history STAY in storage, which is what makes the
  // typed-confirmation honest when it says a mistake is recoverable.
  await access(join(dep.dir, 'books', 'portal-made', 'source', 'one.md'));
  await access(join(dep.dir, 'books', 'portal-made', 'revisions', 'one', 'index.json'));

  // The session is the credential: without it (and without a key), the same
  // routes refuse.
  const { app } = await import('../src/index.ts');
  const executionCtx = { waitUntil(p) { void Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
  const anon = await app.fetch(
    new Request('https://app.example.test/api/content/v1/books/portal-made', {
      method: 'DELETE',
      headers: { 'X-Requested-With': 'storylark' },
    }),
    dep.env,
    executionCtx
  );
  assert.equal(anon.status, 401);
});

test('grandfathering holds: legacy markdown with no storylark block still saves and republishes', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());
  const session = await adminSession(dep);

  // The exact shape every pre-contract chapter in both live deployments has:
  // top-level title, no storylark block.
  const legacy = chapterMarkdown('An Old Chapter');
  const saved = await session('PUT', '/api/admin/content/books/old-book/chapters/one', { markdown: legacy, correction: false });
  assert.equal(saved.status, 200, saved.text);

  // …and the strict machinery had no opinion: the record was transport-identified.
  const manifest = await dep.manifest();
  const book = manifest.books.find((b) => b.id === 'old-book');
  assert.equal(book.chapters[0].title, 'An Old Chapter');

  // A chapter whose file DOES carry a block gets the block's title override.
  const strict = withBlock({ type: 'chapter', book: 'old-book', chapter: 'two', order: 2, title: 'The Block Title' });
  const saved2 = await session('PUT', '/api/admin/content/books/old-book/chapters/two', { markdown: strict, correction: false });
  assert.equal(saved2.status, 200, saved2.text);
  const after = await dep.manifest();
  const two = after.books.find((b) => b.id === 'old-book').chapters.find((ch) => ch.id === 'two');
  assert.equal(two.title, 'The Block Title', 'storylark.title overrides the top-level title');
  const source = await readFile(join(dep.dir, 'books', 'old-book', 'source', 'two.md'), 'utf8');
  assert.match(source, /storylark:/, 'the source is stored verbatim, block and all');
});

test('a batch push honours declared order and rejects a tie without costing the other books', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const res = await dep.call('POST', '/api/content/v1/books', {
    contractVersion: 1,
    books: [
      {
        id: 'ordered-book',
        chapters: [
          // Wire order is 3,1,2 — declared order must win, because explicit
          // beats implicit and the manifest array IS the chapter order.
          { id: 'three', markdown: withBlock({ type: 'chapter', book: 'ordered-book', chapter: 'three', order: 30 }) },
          { id: 'one', markdown: withBlock({ type: 'chapter', book: 'ordered-book', chapter: 'one', order: 10 }) },
          { id: 'two', markdown: withBlock({ type: 'chapter', book: 'ordered-book', chapter: 'two', order: 20 }) },
        ],
      },
      {
        id: 'tied-book',
        chapters: [
          { id: 'a', markdown: withBlock({ type: 'chapter', book: 'tied-book', chapter: 'a', order: 1 }) },
          { id: 'b', markdown: withBlock({ type: 'chapter', book: 'tied-book', chapter: 'b', order: 1 }) },
        ],
      },
    ],
  });
  assert.equal(res.status, 207, res.text);
  const tied = res.json.results.find((r) => r.bookId === 'tied-book');
  assert.equal(tied.ok, false);
  assert.equal(tied.error, 'order_tie');

  const manifest = await dep.manifest();
  assert.deepEqual(
    manifest.books.find((b) => b.id === 'ordered-book').chapters.map((ch) => ch.id),
    ['one', 'two', 'three'],
    'declared storylark.order decides the book order, not wire position'
  );
  assert.equal(manifest.books.find((b) => b.id === 'tied-book'), undefined, 'the tied book wrote nothing');
});

test('CONTENT_ID_RE is the same rule the routes enforce', async () => {
  const { ID_RE } = await import('../src/lib/content.ts');
  assert.equal(ID_RE, CONTENT_ID_RE, 'literally the same RegExp object — the id rule cannot drift');
});
