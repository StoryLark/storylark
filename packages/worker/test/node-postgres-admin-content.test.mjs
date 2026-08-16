// The gap plan §3 named and left open (AB#7412):
//
//   "The authenticated Node/Azure path is untested end to end — it needs
//    Postgres, which wasn't available locally. The routes were proven mounted
//    and correctly gated on that entry, and its storage driver is unit-tested
//    for real, but no signed-in save has been performed through it."
//
// This closes it. Nothing here is a mock: a REAL Postgres holds the users,
// sessions and admin tables; the REAL Postgres driver
// (packages/worker/src/db/postgres.ts) is bound as `DB` exactly as
// platforms/azure/server.mjs binds it; the REAL local content-store driver
// (platforms/azure/content-store.mjs) is bound as `CONTENT_STORE` exactly as
// contentStoreFromEnv does; and every request goes through the REAL Hono app
// (`app` from packages/worker/src/index.ts — the named export the Node entry
// uses, with the driver already bound, NOT the Cloudflare-only default export).
//
// The account is created through the real installer flow — a setup token minted
// with ADMIN_KEY, claimed into an operator account — and every request after
// that carries the real `sr_session` cookie and the real CSRF header. A route
// that isn't genuinely reached by an authenticated request will 401 here.
//
// ── Running it ──────────────────────────────────────────────────────────────
// Point it at any Postgres. It creates its own throwaway database and drops it.
//
//   docker run -d --name slk-pg -e POSTGRES_PASSWORD=storylark \
//     -e POSTGRES_DB=storylark -p 55432:5432 postgres:16-alpine
//   STORYLARK_TEST_POSTGRES="postgres://postgres:storylark@127.0.0.1:55432/postgres" \
//     node --import tsx/esm --test packages/worker/test/node-postgres-admin-content.test.mjs
//
// Without that variable the whole file skips, loudly, rather than passing on a
// mock and claiming the Node path is covered when it isn't.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, '..');

const ADMIN_URL = process.env.STORYLARK_TEST_POSTGRES ?? '';
const skip = ADMIN_URL
  ? false
  : 'set STORYLARK_TEST_POSTGRES to a Postgres connection string (see the header) to run the Node/Azure end-to-end path';

const DB_NAME = `storylark_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const ADMIN_KEY = 'test-admin-key-not-a-secret';

let ctx = null;

before(async () => {
  if (skip) return;

  // A throwaway database per run, so a failed run can never leave state that
  // makes the next one pass (or fail) for the wrong reason.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/?]*(\?|$)/, `/${DB_NAME}$1`);

  // The real migration runner, the real migration set — the same command the
  // Azure installer runs. If a migration is broken on Postgres, this is where
  // it shows up, which is most of the point of testing against a real engine.
  await run(process.execPath, [join(WORKER, 'migrate-postgres.mjs'), `--connection-string=${url}`]);

  const { app } = await import('../src/index.ts');
  const { postgresDatabase } = await import('../src/db/postgres.ts');
  const { localContentStore } = await import('../../../platforms/azure/content-store.mjs');

  const contentDir = await mkdtemp(join(tmpdir(), 'storylark-pg-content-'));
  const db = postgresDatabase(url);

  // Bound exactly as platforms/azure/server.mjs binds it.
  const env = {
    DB: db,
    BRAND: 'storylark',
    APP_ORIGIN: 'https://app.example.test',
    CONTENT_ORIGIN: 'https://content.example.test',
    MAIL_FROM: 'noreply@example.test',
    APP_NAME: 'StoryLark Test',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    RESEND_API_KEY: '',
    ADMIN_KEY,
    ADMIN_EMAIL: '',
    CONTENT_STORE: localContentStore(contentDir),
    CONTENT_REVISIONS: '5',
  };
  const executionCtx = { waitUntil: (p) => void Promise.resolve(p).catch(() => {}), passThroughOnException() {} };

  let cookie = '';
  async function call(path, init = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'storylark', ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const res = await app.fetch(new Request(`https://app.example.test${path}`, { ...init, headers }), env, executionCtx);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON — the caller asserts on status/text */
    }
    return { status: res.status, json, text };
  }

  ctx = { url, db, env, call, contentDir, cookieOf: () => cookie, clearCookie: () => (cookie = '') };
});

after(async () => {
  if (skip || !ctx) return;
  await ctx.db.close?.();
  await rm(ctx.contentDir, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.end();
});

test('the admin content routes are shut to an anonymous caller on the Node path', { skip }, async () => {
  // The gate first, before any credential exists — otherwise a later pass could
  // be a route that is simply open.
  const anon = await ctx.call('/api/admin/content/books');
  assert.equal(anon.status, 401, `expected 401 for an unauthenticated read, got ${anon.status} ${anon.text.slice(0, 120)}`);
});

test('the installer flow creates a real operator account against Postgres', { skip }, async () => {
  const minted = await ctx.call('/api/admin/setup/reset', { method: 'POST', headers: { 'X-Admin-Key': ADMIN_KEY } });
  assert.equal(minted.status, 200, minted.text.slice(0, 200));
  assert.equal(typeof minted.json.setupUrl, 'string');
  assert.equal(minted.json.recoveryCodes.length, 10, 'the printed recovery sheet is part of the same mint');
  // The installer prints the URL; the token is the query parameter in it.
  const setupToken = new URL(minted.json.setupUrl).searchParams.get('setup');
  assert.ok(setupToken && setupToken.length > 20);

  const claimed = await ctx.call('/api/admin/setup/claim', {
    method: 'POST',
    body: JSON.stringify({
      token: setupToken,
      email: 'operator@example.test',
      username: 'operator',
      password: 'a-long-enough-password-1',
    }),
  });
  assert.equal(claimed.status, 200, claimed.text.slice(0, 200));
  assert.equal(claimed.json.user.isAdmin, true);
  assert.ok(ctx.cookieOf().startsWith('sr_session='), 'the claim must set a real session cookie');

  // The row is really in Postgres, not just in a response body.
  const pool = new pg.Pool({ connectionString: ctx.url });
  const { rows } = await pool.query('SELECT email, is_admin FROM users');
  await pool.end();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'operator@example.test');
  assert.ok(rows[0].is_admin, 'the operator flag must be persisted, not inferred');
});

test('a signed-in save writes a chapter through the Node path — the thing never proven before', { skip }, async () => {
  const created = await ctx.call('/api/admin/content/books/lamplight/chapters/full', {
    method: 'PUT',
    body: JSON.stringify({
      markdown: '---\ntitle: Lamplight\nlabel: Read\n---\n\nThe lamp on the corner had been out for a week.\n',
      correction: false,
    }),
  });
  assert.equal(created.status, 200, created.text.slice(0, 300));
  assert.equal(created.json.created, true);
  assert.equal(created.json.wordCount, 11);
  assert.ok(created.json.contentHash);

  // Read it back through the listing, which is what the portal actually draws.
  const listed = await ctx.call('/api/admin/content/books');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.storeAvailable, true);
  const book = listed.json.books.find((b) => b.id === 'lamplight');
  assert.ok(book, 'the saved book must appear in the library listing');
  assert.equal(book.chapters[0].id, 'full');
  assert.equal(book.chapters[0].contentHash, created.json.contentHash);
});

test('preview, download and revisions all answer on the Node path', { skip }, async () => {
  const preview = await ctx.call('/api/admin/content/preview', {
    method: 'POST',
    body: JSON.stringify({ markdown: 'A paragraph.\n\n---\n\n*End of it.*' }),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.blocks.length, 3);
  assert.equal(preview.json.problem, null);

  const download = await ctx.call('/api/admin/content/books/lamplight/chapters/full/download');
  assert.equal(download.status, 200);
  assert.match(download.text, /The lamp on the corner/);

  const revisions = await ctx.call('/api/admin/content/books/lamplight/chapters/full/revisions');
  assert.equal(revisions.status, 200);
  assert.equal(revisions.json.revisions.length, 1);
  assert.equal(revisions.json.revisions[0].live, true);
});

test('a second save appends a revision, and a revert goes through the same path', { skip }, async () => {
  const second = await ctx.call('/api/admin/content/books/lamplight/chapters/full', {
    method: 'PUT',
    body: JSON.stringify({
      markdown: '---\ntitle: Lamplight\nlabel: Read\n---\n\nThe lamp on the corner had been out for a fortnight.\n',
      correction: true,
    }),
  });
  assert.equal(second.status, 200, second.text.slice(0, 200));
  assert.equal(second.json.correction, true);

  const list = await ctx.call('/api/admin/content/books/lamplight/chapters/full/revisions');
  assert.equal(list.json.revisions.length, 2);
  const older = list.json.revisions.find((r) => !r.live);

  const reverted = await ctx.call(`/api/admin/content/books/lamplight/chapters/full/revisions/${older.id}/revert`, {
    method: 'POST',
    body: JSON.stringify({ correction: true }),
  });
  assert.equal(reverted.status, 200, reverted.text.slice(0, 200));

  const after = await ctx.call('/api/admin/content/books/lamplight/chapters/full');
  assert.match(after.json.markdown, /for a week/, 'the revert must put the older text back as live');
});

test('chapter reorder works end to end on the Node path (AB#7412)', { skip }, async () => {
  for (const id of ['two', 'three']) {
    const res = await ctx.call(`/api/admin/content/books/lamplight/chapters/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ markdown: `---\ntitle: ${id}\n---\n\nChapter ${id} of the thing.\n`, correction: false }),
    });
    assert.equal(res.status, 200, res.text.slice(0, 200));
  }

  const before = await ctx.call('/api/admin/content/books');
  assert.deepEqual(
    before.json.books.find((b) => b.id === 'lamplight').chapters.map((c) => c.id),
    ['full', 'two', 'three']
  );

  const reorder = await ctx.call('/api/admin/content/books/lamplight/chapter-order', {
    method: 'PUT',
    body: JSON.stringify({ order: ['three', 'full', 'two'] }),
  });
  assert.equal(reorder.status, 200, reorder.text.slice(0, 200));
  assert.deepEqual(reorder.json.order, ['three', 'full', 'two']);

  const after = await ctx.call('/api/admin/content/books');
  assert.deepEqual(
    after.json.books.find((b) => b.id === 'lamplight').chapters.map((c) => c.id),
    ['three', 'full', 'two'],
    'the new order must survive being read back out of storage'
  );
  assert.ok(after.json.libraryVersion > before.json.libraryVersion, 'readers must be made to re-fetch');
  assert.equal(after.json.announceVersion, before.json.announceVersion, 'rearranging chapters is not new content');
});

test('a reorder that would drop a chapter is refused with 409, on this path too', { skip }, async () => {
  const bad = await ctx.call('/api/admin/content/books/lamplight/chapter-order', {
    method: 'PUT',
    body: JSON.stringify({ order: ['three', 'full'] }),
  });
  assert.equal(bad.status, 409, bad.text.slice(0, 200));
  assert.equal(bad.json.error, 'order_mismatch');

  const after = await ctx.call('/api/admin/content/books');
  assert.equal(after.json.books.find((b) => b.id === 'lamplight').chapters.length, 3, 'nothing may have been dropped');
});

test('conflict detection: a save against a superseded version is refused with 409 (AB#7412)', { skip }, async () => {
  const opened = await ctx.call('/api/admin/content/books/lamplight/chapters/two');
  assert.equal(opened.status, 200);
  const baseContentHash = opened.json.contentHash;

  // Something else lands while our editor "has the chapter open" — a
  // publish.mjs run or a second tab; indistinguishable from here, and both must
  // be caught.
  const landed = await ctx.call('/api/admin/content/books/lamplight/chapters/two', {
    method: 'PUT',
    body: JSON.stringify({ markdown: '---\ntitle: two\n---\n\nText that landed while you were typing.\n', correction: true }),
  });
  assert.equal(landed.status, 200);
  assert.notEqual(landed.json.contentHash, baseContentHash);

  const stale = await ctx.call('/api/admin/content/books/lamplight/chapters/two', {
    method: 'PUT',
    body: JSON.stringify({ markdown: '---\ntitle: two\n---\n\nThe draft that started before all that.\n', baseContentHash, correction: true }),
  });
  assert.equal(stale.status, 409, stale.text.slice(0, 300));
  assert.equal(stale.json.error, 'stale_edit');
  assert.equal(stale.json.liveContentHash, landed.json.contentHash);

  // The refusal must have changed nothing.
  const untouched = await ctx.call('/api/admin/content/books/lamplight/chapters/two');
  assert.match(untouched.json.markdown, /landed while you were typing/);

  // …and `force` is the deliberate way through.
  const forced = await ctx.call('/api/admin/content/books/lamplight/chapters/two', {
    method: 'PUT',
    body: JSON.stringify({
      markdown: '---\ntitle: two\n---\n\nThe draft that started before all that.\n',
      baseContentHash,
      force: true,
      correction: true,
    }),
  });
  assert.equal(forced.status, 200, forced.text.slice(0, 200));
  const won = await ctx.call('/api/admin/content/books/lamplight/chapters/two');
  assert.match(won.json.markdown, /started before all that/);
});

test('an up-to-date base hash saves normally — the check cannot block ordinary work', { skip }, async () => {
  const opened = await ctx.call('/api/admin/content/books/lamplight/chapters/three');
  const res = await ctx.call('/api/admin/content/books/lamplight/chapters/three', {
    method: 'PUT',
    body: JSON.stringify({
      markdown: '---\ntitle: three\n---\n\nAn ordinary edit by the only person editing.\n',
      baseContentHash: opened.json.contentHash,
      correction: true,
    }),
  });
  assert.equal(res.status, 200, res.text.slice(0, 200));
});

test('deleting a chapter, and then the whole session, behave on the Node path', { skip }, async () => {
  const del = await ctx.call('/api/admin/content/books/lamplight/chapters/three', { method: 'DELETE' });
  assert.equal(del.status, 200, del.text.slice(0, 200));

  const listed = await ctx.call('/api/admin/content/books');
  assert.deepEqual(
    listed.json.books.find((b) => b.id === 'lamplight').chapters.map((c) => c.id),
    ['full', 'two']
  );

  // Sign out, and confirm the routes shut again — the session really was what
  // was letting all of the above through.
  const out = await ctx.call('/api/auth/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  ctx.clearCookie();
  const shut = await ctx.call('/api/admin/content/books');
  assert.equal(shut.status, 401);
});
