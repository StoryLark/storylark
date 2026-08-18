// Full response-shape regression guard for GET /api/admin/status (plan §1).
//
// postgres-numeric-parity.test.mjs already covers HALF of this: it proves
// the pg bigint (OID 20) type parser makes COUNT(*) come back as a plain
// number on Postgres, matching D1's native behavior. This test covers the
// OTHER half — and does it end-to-end rather than by re-asserting the same
// parser in isolation: it runs the REAL /status route handler, through the
// REAL Hono app, against TWO real databases (one D1-shaped, one
// Postgres-shaped) seeded with equivalent data, and asserts the two
// responses are field-for-field, type-for-type identical — not just the
// pushSubscriptions count, the WHOLE shape (brand, engineVersion, bookCount,
// chapterCount, pushSubscriptions, release). Note appName was removed from
// this response earlier in this session (Admin.tsx now reads BRAND.appName
// directly) — this test does not expect it back. `release` (AB#7653) is
// additive and, with no ASSETS binding in this test's fake env, comes back
// with build/coreVersion null on both drivers alike — still asserted
// byte-identical between them, which is the property this file exists to
// guard.
//
// ── Why PGlite instead of a real standalone Postgres server ─────────────────
//
// This sandbox has no way to reach a real, separately-running Postgres:
// checked `psql`/`pg_ctl` on PATH (neither present), `docker` (not
// installed), any docker-compose file in the repo (none), and any CI
// Postgres service definition in .github/workflows (none). So this test
// uses @electric-sql/pglite — actual PostgreSQL compiled to WASM, not a
// mock or a hand-rolled shape stand-in — fronted by
// @electric-sql/pglite-socket, which opens a REAL TCP server speaking the
// REAL Postgres wire protocol. The REAL `pg` npm client this repo already
// depends on (the same one packages/worker/src/db/postgres.ts uses)
// connects to it exactly as it would to Azure Database for PostgreSQL. Then
// the REAL, unmodified migrate-postgres.mjs script is spawned as a child
// process against it — the exact same script `platforms/azure/install.mjs`
// runs against a real deployment, migrating via `CREATE EXTENSION citext`
// and all. Confirmed live in this test: all 8 migrations-postgres/*.sql
// files apply cleanly, citext included (PGlite bundles it as a loadable
// contrib extension). The D1 side is the mirror of this: node:sqlite's
// DatabaseSync (a real SQL engine, not a mock), migrated with the same
// applyD1Migrations() runner engine-update.test.mjs's own D1 migration
// tests use, wrapped through the real d1Database() driver.
//
// Both sides then go through the SAME real driver factory functions
// production code calls (d1Database() / postgresDatabase()) and the SAME
// real Hono route handler (the exported `admin` app, called via
// admin.request() — not a reimplementation of the route's logic). A
// regression in the route's response shape, or in either driver's value
// marshalling, fails this test on either platform independently, plus a
// third way: the two responses no longer matching each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

import { admin } from '../src/routes/admin.ts';
import { d1Database } from '../src/db/d1.ts';
import { postgresDatabase } from '../src/db/postgres.ts';
import { applyD1Migrations } from '../src/lib/self-deploy.ts';
import { sha256Hex } from '../src/lib/crypto.ts';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(__dirname, '..');

/** Same fixture manifest served to both drivers, so bookCount/chapterCount agree by construction. */
const MANIFEST = {
  books: [
    { id: 'book-a', chapters: [{ id: 'ch1' }, { id: 'ch2' }] },
    { id: 'book-b', chapters: [{ id: 'ch1' }] },
  ],
};

async function manifestServer() {
  const server = createServer((req, res) => {
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(MANIFEST));
    }
    res.writeHead(404).end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/** The Database seam over node:sqlite (mirrors engine-update.test.mjs's own sqliteSeam). */
function sqliteSeam(db) {
  return {
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...values) {
          bound = values;
          return stmt;
        },
        async run() {
          db.prepare(sql).run(...bound);
          return { success: true };
        },
        async all() {
          return { results: db.prepare(sql).all(...bound) };
        },
        async first() {
          return db.prepare(sql).get(...bound) ?? null;
        },
      };
      return stmt;
    },
  };
}

function readMigrations(dir) {
  const map = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    map.set(file, readFileSync(join(dir, file)));
  }
  return map;
}

/** Identical fixture data seeded into whichever Database seam is passed — same SQL, either driver. */
async function seedFixture(db, { userId, email, rawSessionToken, pushSubscriptionCount }) {
  // Real wall-clock time, not a fixed constant: requireAdmin()'s session
  // check compares expires_at against the real Date.now() at request time
  // (session.ts's loadUser), so a fixed past timestamp here would read as an
  // already-expired session and every request would 401 regardless of which
  // driver is being tested. None of these timestamps are part of the
  // /status response being compared, so real-time seeding costs nothing.
  const now = Date.now();
  await db
    .prepare('INSERT INTO users (id, email, created_at, last_seen_at, is_admin) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, email, now, now, 1)
    .run();
  const sessionId = await sha256Hex(rawSessionToken);
  await db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(sessionId, userId, now, now + 1000 * 60 * 60 * 24, 'parity-test')
    .run();
  for (let i = 0; i < pushSubscriptionCount; i++) {
    await db
      .prepare('INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(`https://push.example/${i}`, userId, `p256dh-${i}`, `auth-${i}`, now)
      .run();
  }
}

async function buildD1({ pushSubscriptionCount }) {
  const sqlite = new DatabaseSync(':memory:');
  const seam = sqliteSeam(sqlite);
  const migrations = readMigrations(join(WORKER_ROOT, 'migrations'));
  await applyD1Migrations(seam, migrations, () => {});
  const db = d1Database(seam);
  await seedFixture(db, {
    userId: 'user-1',
    email: 'admin@example.com',
    rawSessionToken: 'd1-raw-token',
    pushSubscriptionCount,
  });
  return { db, rawSessionToken: 'd1-raw-token', close: async () => sqlite.close() };
}

async function buildPostgres({ pushSubscriptionCount }) {
  const pglite = new PGlite({ extensions: { citext } });
  // High, PID-derived port to make an accidental collision with a real local
  // service (or a second concurrent test run) unlikely without adding a
  // port-scanning dependency just for this one test.
  const port = 15400 + (process.pid % 4000);
  const socketServer = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1', maxConnections: 5 });
  await socketServer.start();
  const connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;

  // The REAL migration script, unmodified, run exactly as
  // platforms/azure/install.mjs runs it against a real deployment — spawned
  // async (not execFileSync) so this process's event loop stays free to
  // service the PGLiteSocketServer's TCP connection from the child process;
  // a synchronous spawn here deadlocks the two against each other (confirmed
  // while building this test — execFileSync hung indefinitely).
  await execFileAsync('node', [join(WORKER_ROOT, 'migrate-postgres.mjs'), `--connection-string=${connectionString}`]);

  const db = postgresDatabase(connectionString);
  await seedFixture(db, {
    userId: 'user-1',
    email: 'admin@example.com',
    rawSessionToken: 'postgres-raw-token',
    pushSubscriptionCount,
  });
  return {
    db,
    rawSessionToken: 'postgres-raw-token',
    close: async () => {
      await db.close();
      await socketServer.stop();
      await pglite.close();
    },
  };
}

async function fetchStatus({ db, rawSessionToken, brand, contentOrigin }) {
  const env = { DB: db, BRAND: brand, CONTENT_ORIGIN: contentOrigin };
  const res = await admin.request('/status', { headers: { cookie: `sr_session=${rawSessionToken}` } }, env);
  assert.equal(res.status, 200, `expected a 200 from a valid admin session, got ${res.status}`);
  return res.json();
}

test('GET /api/admin/status returns a byte-identical shape on D1 and on Postgres', async (t) => {
  const manifest = await manifestServer();
  t.after(() => new Promise((r) => manifest.server.close(r)));

  const d1 = await buildD1({ pushSubscriptionCount: 3 });
  t.after(d1.close);
  const postgres = await buildPostgres({ pushSubscriptionCount: 3 });
  t.after(postgres.close);

  const brand = 'parity-test-brand';
  const [d1Json, postgresJson] = await Promise.all([
    fetchStatus({ ...d1, brand, contentOrigin: manifest.origin }),
    fetchStatus({ ...postgres, brand, contentOrigin: manifest.origin }),
  ]);

  // The headline assertion: the two drivers must produce the exact same JSON
  // for equivalent data — not just "both are objects with the right keys".
  assert.deepEqual(
    postgresJson,
    d1Json,
    'Postgres and D1 must return byte-identical /api/admin/status JSON for equivalent data'
  );

  // Pin down the actual shape too, so a future change that alters BOTH
  // drivers identically (and would therefore still pass the deepEqual above)
  // still has to updated this test deliberately, not by accident.
  assert.deepEqual(Object.keys(d1Json).sort(), [
    'bookCount',
    'brand',
    'chapterCount',
    'engineVersion',
    'pushSubscriptions',
    'release',
  ]);
  assert.equal(d1Json.brand, brand);
  assert.equal(typeof d1Json.engineVersion, 'string');
  assert.equal(d1Json.bookCount, 2);
  assert.equal(d1Json.chapterCount, 3);
  assert.equal(d1Json.pushSubscriptions, 3);

  // release (AB#7653): no ASSETS binding in this fake env, so build/coreVersion
  // stay null on both drivers — workerVersion always answers from the package.
  assert.deepEqual(Object.keys(d1Json.release).sort(), ['build', 'coreVersion', 'workerVersion']);
  assert.equal(d1Json.release.build, null);
  assert.equal(d1Json.release.coreVersion, null);
  assert.equal(typeof d1Json.release.workerVersion, 'string');
  assert.equal(d1Json.release.workerVersion, d1Json.engineVersion);

  // Explicit type-for-type checks — the exact regression class this guards
  // against is a value coming back as the right number but the wrong JS
  // type (Postgres's bigint-as-string being the confirmed real-world case).
  for (const key of ['bookCount', 'chapterCount', 'pushSubscriptions']) {
    assert.equal(typeof d1Json[key], 'number', `D1 ${key} must be a number`);
    assert.equal(typeof postgresJson[key], 'number', `Postgres ${key} must be a number`);
  }

  // appName was removed from this response earlier this session (AB#7412) —
  // the admin portal now reads BRAND.appName from brand.json directly rather
  // than echoing c.env.APP_NAME. Guard against it silently coming back.
  assert.ok(!('appName' in d1Json), 'appName must not be present in /status — Admin.tsx reads BRAND.appName instead');
  assert.ok(!('appName' in postgresJson), 'appName must not be present in /status — Admin.tsx reads BRAND.appName instead');
});

test('GET /api/admin/status is honest about the driver failing on both platforms alike', async (t) => {
  // Same shape guarantee under the *unhappy* path: the route's push-count
  // query fails (bad DB), which both drivers must report as `null`, not as
  // two different failure shapes (e.g. a thrown 500 on one platform and a
  // silent null on the other — that mismatch would be exactly the kind of
  // driver-shape divergence this whole file exists to catch).
  const manifest = await manifestServer();
  t.after(() => new Promise((r) => manifest.server.close(r)));

  const d1 = await buildD1({ pushSubscriptionCount: 0 });
  t.after(d1.close);
  const postgres = await buildPostgres({ pushSubscriptionCount: 0 });
  t.after(postgres.close);

  // Break the table on both sides identically, after the valid session was
  // already seeded against it — same fault, both platforms.
  await d1.db.prepare('DROP TABLE push_subscriptions').run();
  await postgres.db.prepare('DROP TABLE push_subscriptions').run();

  const brand = 'parity-test-brand-broken';
  const [d1Json, postgresJson] = await Promise.all([
    fetchStatus({ ...d1, brand, contentOrigin: manifest.origin }),
    fetchStatus({ ...postgres, brand, contentOrigin: manifest.origin }),
  ]);

  assert.equal(d1Json.pushSubscriptions, null);
  assert.equal(postgresJson.pushSubscriptions, null);
  assert.deepEqual(postgresJson, d1Json);
});
