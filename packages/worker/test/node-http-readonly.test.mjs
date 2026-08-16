// Read-only enforcement for externally-managed content, proven at the HTTP
// level ON THE NODE/AZURE STACK (AB#7412 — closing the gap AB#7422 recorded).
//
// ── What was and was not already covered ────────────────────────────────────
// The `409 managed_externally` rule (plan §8: *whoever owns the content owns the
// edit button*) was verified two ways when it was built:
//
//   • at the HTTP level against Cloudflare — a real `wrangler dev`, local D1,
//     local R2, 21 checks;
//   • at the engine + storage-driver level on Node —
//     packages/worker/test/content-origin.test.mjs.
//
// What was NOT covered was the Node/Azure entry's own stack end to end: the
// Postgres driver underneath instead of D1, a real TCP socket in front instead
// of workerd. That was stated plainly at the time — "there is no local
// Postgres/Docker on this machine" — rather than glossed over. This test is that
// missing half, and it needs a real PostgreSQL to be worth anything, so it starts
// one (see ./postgres-server.mjs for how, on a machine with no Docker).
//
// ── What is real here ───────────────────────────────────────────────────────
//   • A real PostgreSQL server, with the REAL shipped migrations-postgres/*.sql
//     applied by the REAL shipped migrate-postgres.mjs. If the Postgres dialect
//     of any migration is wrong, this test cannot even start.
//   • The real `postgresDatabase()` driver bound to `env.DB`, exactly as
//     platforms/azure/server.mjs binds it.
//   • The real content store driver the Node entry uses
//     (platforms/azure/content-store.mjs), writing real files.
//   • A real `node:http` server over a real port, so every request crosses a
//     socket, is parsed by Node's HTTP stack, and comes back as bytes.
//   • A real session: a row in `sessions`, and a real `sr_session` cookie.
//
// The one thing constructed rather than spawned is the server wiring itself.
// platforms/azure/server.mjs consumes `storylark-worker` from npm, so spawning
// it would test the last published release rather than this source tree — the
// exact reason AB#7422 gave for not doing this before. The three lines that
// matter (postgresDatabase → env.DB, contentStoreFromEnv → env.CONTENT_STORE,
// the waitUntil polyfill) are reproduced verbatim from it below.
//
//   node --import tsx/esm --test packages/worker/test/node-http-readonly.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { startPostgres, migrate } from './postgres-server.mjs';
import { localContentStore } from '../../../platforms/azure/content-store.mjs';
import { postgresDatabase } from '../src/db/postgres.ts';
import { sha256Hex, randomToken } from '../src/lib/crypto.ts';
import { app } from '../src/index.ts';

const { server: postgres, reason } = await startPostgres();

if (!postgres) {
  test('Node/Azure HTTP read-only enforcement — SKIPPED, no PostgreSQL', (t) => {
    // Loud on purpose. A skipped test that says nothing is a test that quietly
    // stops covering the thing it was written for.
    t.diagnostic(reason);
    t.skip(reason);
  });
} else {
  const deployment = await bootDeployment(postgres.connectionString);

  test.after(async () => {
    await deployment.close();
    await postgres.stop();
  });

  test('the real Postgres migration set applies cleanly, including the narration queue', async (t) => {
    t.diagnostic(`PostgreSQL engine: ${postgres.engine}`);
    const { rows } = await deployment.query('SELECT name FROM schema_migrations ORDER BY name');
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('0001_init.sql'));
    assert.ok(names.includes('0008_narration_queue.sql'), 'the new migration ran on real Postgres, not just SQLite');

    // And the tables it declares really exist, with the columns the queue reads.
    const cols = await deployment.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'narration_jobs' ORDER BY column_name"
    );
    const columns = cols.rows.map((r) => r.column_name);
    for (const expected of ['batch_id', 'book_id', 'chapter_id', 'content_hash', 'elapsed_ms', 'status']) {
      assert.ok(columns.includes(expected), `narration_jobs.${expected} is missing on Postgres`);
    }
  });

  test('over real HTTP on the Node stack: synced content is READABLE', async () => {
    const res = await deployment.request('GET', '/api/admin/content/books');
    assert.equal(res.status, 200, res.text);
    const synced = res.json.books.find((b) => b.id === 'synced-library');
    assert.ok(synced, 'a synced book must still be listed — an operator needs to see their whole library');
    assert.equal(synced.readOnly, true);
    assert.equal(synced.origin, 'sync');
    assert.equal(synced.syncSource.url, 'https://git.example.com/press/site.git');
    assert.equal(synced.chapters[0].readOnly, true);

    // The books that are NOT synced are still writable, on this stack too.
    assert.equal(res.json.books.find((b) => b.id === 'cli-library').readOnly, false);
    assert.equal(res.json.books.find((b) => b.id === 'legacy-library').readOnly, false, 'a library predating `origin` stays editable');

    const chapter = await deployment.request('GET', '/api/admin/content/books/synced-library/chapters/chapter-one');
    assert.equal(chapter.status, 200);
    assert.equal(chapter.json.readOnly, true);
    assert.ok(chapter.json.markdown.length > 0, 'and still openable, read-only');

    const download = await deployment.request('GET', '/api/admin/content/books/synced-library/chapters/chapter-one/download');
    assert.equal(download.status, 200, 'a download is a read and stays open');
  });

  test('over real HTTP on the Node stack: every write route answers 409 managed_externally', async () => {
    const cases = [
      ['PUT', '/api/admin/content/books/synced-library/chapters/chapter-one', { markdown: '---\ntitle: x\n---\n\nTyped in the portal.\n' }],
      ['DELETE', '/api/admin/content/books/synced-library/chapters/chapter-one', undefined],
      ['PUT', '/api/admin/content/books/synced-library', { title: 'Renamed by an operator' }],
      ['POST', '/api/admin/content/books/synced-library/chapters/chapter-one/revisions/1/revert', {}],
    ];
    for (const [method, path, body] of cases) {
      const res = await deployment.request(method, path, body);
      assert.equal(res.status, 409, `${method} ${path} answered ${res.status}: ${res.text}`);
      assert.equal(res.json.error, 'managed_externally');
      assert.equal(res.json.origin, 'sync');
      assert.equal(res.json.syncSource.kind, 'git');
      assert.match(res.json.message, /edit it at source/i);
      assert.match(res.json.message, /git\.example\.com/, 'the refusal names the source, over HTTP, on Postgres');
    }

    // And it is a refusal, not a partial write: the manifest is untouched.
    const manifest = await deployment.manifest();
    const synced = manifest.books.find((b) => b.id === 'synced-library');
    assert.equal(synced.title, "Somebody Else's Catalogue");
    assert.equal(synced.chapters.length, 1);
    assert.equal(synced.chapters[0].contentHash, 'cccccccc');
    assert.equal(manifest.libraryVersion, 7, 'nothing bumped the library version');
  });

  test('over real HTTP on the Node stack: an image upload into a synced book is refused too', async () => {
    const form = new FormData();
    form.set('bookId', 'synced-library');
    form.set('kind', 'cover');
    form.set('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'cover.png');
    const res = await deployment.requestRaw('POST', '/api/admin/upload', form);
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error, 'managed_externally');
  });

  test('over real HTTP on the Node stack: a NON-synced chapter still saves, end to end', async () => {
    const res = await deployment.request('PUT', '/api/admin/content/books/cli-library/chapters/full', {
      markdown: '---\ntitle: A CLI Chapter\n---\n\nFixed a typo, through Postgres, over a socket.\n',
      correction: true,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.correction, true);

    const manifest = await deployment.manifest();
    const book = manifest.books.find((b) => b.id === 'cli-library');
    assert.equal(book.chapters[0].origin, 'cli', 'a portal edit does not relabel where content came from');
    assert.ok(manifest.libraryVersion > 7);

    // library_state moved in POSTGRES, and reads back as a NUMBER — the D1/pg
    // parity rule postgres-numeric-parity.test.mjs guards at the type-parser
    // level, here proven through the whole stack.
    const version = await deployment.request('GET', '/api/library/version');
    assert.equal(version.status, 200);
    assert.equal(typeof version.json.version, 'number');
    assert.equal(version.json.version, manifest.libraryVersion);
  });

  test('over real HTTP on the Node stack: the content API refuses the same book, and accepts one it owns', async () => {
    const refused = await deployment.request(
      'PUT',
      '/api/content/v1/books/synced-library',
      { contractVersion: 1, chapters: [{ id: 'chapter-one', markdown: '---\ntitle: x\n---\n\nPushed over the API.\n' }] },
      { 'X-Admin-Key': deployment.adminKey }
    );
    assert.equal(refused.status, 422, refused.text);
    assert.match(refused.json.message, /git\.example\.com/);

    const accepted = await deployment.request(
      'PUT',
      '/api/content/v1/books/pushed-library',
      {
        contractVersion: 1,
        title: 'Pushed In',
        source: { url: 'https://press.example.com/x', system: 'Acme CMS' },
        chapters: [{ id: 'one', markdown: '---\ntitle: One\n---\n\nPushed over the API, into Postgres.\n' }],
      },
      { 'X-Admin-Key': deployment.adminKey }
    );
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.json.summary.chaptersSucceeded, 1);
    assert.equal(accepted.json.narration.queued, 1, 'the queue works on Postgres, over HTTP');

    // …and the portal now refuses THAT book too, for the same reason.
    const portal = await deployment.request('PUT', '/api/admin/content/books/pushed-library/chapters/one', {
      markdown: '---\ntitle: One\n---\n\nEdited in the portal instead.\n',
    });
    assert.equal(portal.status, 409);
    assert.match(portal.json.message, /Acme CMS/);
  });

  test('over real HTTP on the Node stack: the narration queue claims and completes against Postgres', async () => {
    const view = await deployment.request('GET', '/api/admin/narration');
    assert.equal(view.status, 200, view.text);
    assert.equal(view.json.available, true);
    assert.equal(typeof view.json.counts.pending, 'number', 'counts must be numbers on Postgres, not strings');
    assert.ok(view.json.counts.pending >= 1);

    const claim = await deployment.request('POST', '/api/admin/narration/claim', { worker: 'pg-runner', max: 5 }, {
      'X-Admin-Key': deployment.adminKey,
    });
    assert.equal(claim.status, 200, claim.text);
    assert.ok(claim.json.jobs.length >= 1);
    const job = claim.json.jobs.find((j) => j.bookId === 'pushed-library');
    assert.ok(job, 'the pushed chapter is in the queue');
    assert.equal(job.attempts, 1, 'attempts increments on Postgres and reads back as a number');

    // A second claim gets nothing back for the same job — the conditional
    // UPDATE that decides a claim behaves the same on Postgres as on SQLite.
    const second = await deployment.request('POST', '/api/admin/narration/claim', { worker: 'other-runner', max: 5 }, {
      'X-Admin-Key': deployment.adminKey,
    });
    assert.equal(second.json.jobs.find((j) => j.id === job.id), undefined);

    const done = await deployment.request(
      'POST',
      `/api/admin/narration/jobs/${job.id}/complete`,
      { audio: job.audioKey, timings: job.timingsKey, durationMs: 12_000, elapsedMs: 3_000, contentHash: job.contentHash },
      { 'X-Admin-Key': deployment.adminKey }
    );
    assert.equal(done.status, 200, done.text);

    const manifest = await deployment.manifest();
    const chapter = manifest.books.find((b) => b.id === 'pushed-library').chapters[0];
    assert.equal(chapter.hasAudio, true);
    assert.equal(chapter.audioStale, false);
    assert.equal(chapter.audioDurationMs, 12_000);
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * The deployment under test
 * ──────────────────────────────────────────────────────────────────────────── */

async function bootDeployment(connectionString) {
  await migrate(connectionString);
  const db = postgresDatabase(connectionString);

  const dir = await mkdtemp(join(tmpdir(), 'storylark-node-http-'));
  await seedLibrary(dir);

  // Exactly what platforms/azure/server.mjs binds, in the same shape.
  const adminKey = 'node-http-test-key';
  const env = {
    DB: db,
    CONTENT_STORE: localContentStore(dir),
    BRAND: 'storylark-test',
    APP_ORIGIN: 'https://app.example.test',
    CONTENT_ORIGIN: 'https://content.example.test',
    MAIL_FROM: 'noreply@example.test',
    APP_NAME: 'StoryLark Node Test',
    ADMIN_KEY: adminKey,
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    RESEND_API_KEY: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    GITHUB_REPO: '',
    GITHUB_DEPLOY_TOKEN: '',
    ADMIN_EMAIL: '',
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
  };
  // The same waitUntil polyfill the Node entry uses: run it, log a failure,
  // never throw into the request.
  const executionCtx = {
    waitUntil(promise) {
      void Promise.resolve(promise).catch(() => {});
    },
    passThroughOnException() {},
  };

  // A real admin account and a real session row, so the cookie below is one the
  // shipped `requireAdmin()` genuinely resolves.
  const now = Date.now();
  await db
    .prepare('INSERT INTO users (id, email, username, created_at, last_seen_at, is_admin) VALUES (?, ?, ?, ?, ?, 1)')
    .bind('u_test', 'operator@example.test', 'operator', now, now)
    .run();
  const rawSession = randomToken(32);
  await db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(rawSession), 'u_test', now, now + 3_600_000, 'node-test')
    .run();

  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0;
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const response = await app.fetch(request, env, executionCtx);
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'test_harness', message: String(err?.stack ?? err) }));
    }
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const base = `http://127.0.0.1:${port}`;

  async function requestRaw(method, path, body, extraHeaders = {}) {
    const headers = {
      Cookie: `sr_session=${rawSession}`,
      'X-Requested-With': 'storylark',
      ...extraHeaders,
    };
    const init = { method, headers };
    if (body !== undefined) {
      if (body instanceof FormData) init.body = body;
      else {
        init.body = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }
    }
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON — `text` is what the assertion will read */
    }
    return { status: res.status, json, text };
  }

  return {
    adminKey,
    request: (method, path, body, extraHeaders) => requestRaw(method, path, body, extraHeaders),
    requestRaw,
    manifest: async () => JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'manifest.json'), 'utf8')),
    query: async (sql) => {
      const { results } = await db.prepare(sql).bind().all();
      return { rows: results };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * The same mixed library content-origin.test.mjs uses: a synced catalogue, a
 * CLI-published book, and one written before `origin` existed at all. Mixing is
 * the point — the rule has to hold per book, not per deployment.
 */
async function seedLibrary(dir) {
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
          { id: 'full', title: 'A Legacy Chapter', wordCount: 9, audioDurationMs: 0, contentHash: 'aaaaaaaa', content: 'books/legacy-library/chapters/full.aaaaaaaa.json', hasAudio: false },
        ],
      },
      {
        id: 'cli-library',
        title: 'Published From A Laptop',
        origin: 'cli',
        chapters: [
          { id: 'full', title: 'A CLI Chapter', wordCount: 9, audioDurationMs: 0, contentHash: 'bbbbbbbb', content: 'books/cli-library/chapters/full.bbbbbbbb.json', source: 'books/cli-library/source/full.md', hasAudio: true },
        ],
      },
      {
        id: 'synced-library',
        title: "Somebody Else's Catalogue",
        origin: 'sync',
        syncSource: { kind: 'git', url: 'https://git.example.com/press/site.git', ref: 'main', syncedAt: '2026-08-16T00:00:00.000Z' },
        chapters: [
          { id: 'chapter-one', title: 'A Synced Chapter', wordCount: 9, audioDurationMs: 0, contentHash: 'cccccccc', content: 'books/synced-library/chapters/chapter-one.cccccccc.json', source: 'books/synced-library/source/chapter-one.md', hasAudio: true, origin: 'sync' },
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
      JSON.stringify({
        id: chapter,
        bookId: book,
        title: 'x',
        blocks: [{ id: 'b1', type: 'paragraph', text: 'The original words, as published.' }],
        charLength: 33,
      })
    );
  }
}
