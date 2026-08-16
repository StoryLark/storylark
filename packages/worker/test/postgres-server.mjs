// A REAL PostgreSQL server, started for the duration of a test (AB#7412).
//
// ── Why this exists ─────────────────────────────────────────────────────────
// The read-only enforcement for externally-managed content (AB#7422 — plan §8)
// was proven at the HTTP level against Cloudflare + D1, and at the engine level
// against the Node storage driver, but never against the Node/Azure entry's own
// stack: Postgres underneath, a real socket in front. That gap was recorded
// honestly at the time ("there is no local Postgres/Docker on this machine")
// rather than papered over. This closes it.
//
// ── How, on a machine with no Docker and no installed Postgres ──────────────
// `embedded-postgres` ships the real PostgreSQL binaries for the host platform.
// Two things had to be worked around, and both are recorded here because the
// next person will hit them:
//
//  1. **Windows refuses to run `postgres` as an administrator.** The server
//     exits with "Execution of PostgreSQL by a user with administrative
//     permissions is not permitted." `embedded-postgres`'s own `start()` spawns
//     the `postgres` binary directly and so trips this. `pg_ctl start` does not:
//     on Windows it creates a RESTRICTED process token for the server, which is
//     exactly the mitigation that refusal is asking for. So this module drives
//     the bundled binaries through `pg_ctl` rather than through the library's
//     own launcher.
//  2. **`pg_ctl` appears to hang under `execFile`.** It does not — it has
//     exited, but the postmaster it left running inherited the stdio pipes, so
//     the promise never settles. `stdio: 'ignore'` fixes it, and readiness is
//     then established by actually connecting rather than by trusting `-w`.
//
// ── Two engines, preferred in order ─────────────────────────────────────────
//  1. `embedded-postgres` — the real native PostgreSQL server, a real process
//     with a real planner and real locking. Preferred when installed, because it
//     is the same binary a deployment runs.
//  2. `@electric-sql/pglite` fronted by `@electric-sql/pglite-socket` — real
//     PostgreSQL compiled to WASM, behind a real TCP server speaking the real
//     wire protocol. Already a committed devDependency of this package, so this
//     test runs everywhere rather than only where step 1 was installed by hand.
//
// Both are driven through the same `pg` client the shipped Postgres driver uses,
// and both have the same shipped migration runner pointed at them. If NEITHER is
// available, `startPostgres()` returns null with a reason and the caller SKIPS
// loudly — never silently, and never by pretending a Postgres-specific assertion
// passed without a Postgres.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

/** Where `embedded-postgres` puts the binaries for this host. */
function binDir() {
  const key = `${platform()}-${arch()}`.replace('win32', 'windows').replace('x64', 'x64');
  const candidates = [
    join(REPO, 'node_modules', '@embedded-postgres', key, 'native', 'bin'),
    join(REPO, 'node_modules', '@embedded-postgres', `${platform()}-${arch()}`, 'native', 'bin'),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

const EXE = platform() === 'win32' ? '.exe' : '';

function runTool(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // stdio ignored on purpose — see note 2 at the top of this file.
    const child = spawn(file, args, { stdio: 'ignore', ...opts });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`))));
  });
}

/**
 * Start a throwaway PostgreSQL and return `{ connectionString, stop() }`, or
 * `null` with a `reason` when the binaries are not present.
 */
export async function startPostgres({ port = 55_400 + Math.floor(Math.random() * 120) } = {}) {
  // STORYLARK_TEST_PG=pglite forces the fallback, so both engines can be
  // exercised on a machine that has the native one.
  const bin = process.env.STORYLARK_TEST_PG === 'pglite' ? null : binDir();
  if (!bin) return startPglite(port + 200);

  const dir = await mkdtemp(join(tmpdir(), 'storylark-pg-'));
  const data = join(dir, 'data');
  const pwFile = join(dir, 'pw.txt');
  await writeFile(pwFile, 'storylark');

  await runTool(join(bin, `initdb${EXE}`), ['-D', data, '-U', 'storylark', '-A', 'password', '--pwfile', pwFile, '-E', 'UTF8']);
  await runTool(join(bin, `pg_ctl${EXE}`), [
    '-D', data,
    '-l', join(dir, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`,
    'start',
  ]);

  const pg = (await import('pg')).default;
  const admin = `postgres://storylark:storylark@127.0.0.1:${port}/postgres`;
  await waitForReady(pg, admin);

  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query('CREATE DATABASE storylark_test');
  await client.end();

  return {
    server: {
      connectionString: `postgres://storylark:storylark@127.0.0.1:${port}/storylark_test`,
      port,
      engine: 'embedded-postgres',
      async stop() {
        await runTool(join(bin, `pg_ctl${EXE}`), ['-D', data, '-m', 'immediate', 'stop']).catch(() => {});
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    },
    reason: null,
  };
}

/**
 * Fallback engine: real PostgreSQL compiled to WASM, behind a real TCP server
 * speaking the real wire protocol. The `pg` client cannot tell the difference,
 * which is the point — the driver, the migrations and the routes under test are
 * all the shipped ones either way.
 */
async function startPglite(port) {
  let PGlite;
  let citext;
  let PGLiteSocketServer;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
    ({ citext } = await import('@electric-sql/pglite/contrib/citext'));
    ({ PGLiteSocketServer } = await import('@electric-sql/pglite-socket'));
  } catch (err) {
    return {
      server: null,
      reason:
        `Neither PostgreSQL engine is available (${(err).message}). Install one: \`npm install --no-save embedded-postgres\` at the repo root for the real native server, ` +
        'or `npm install` in packages/worker for the @electric-sql/pglite fallback this package already declares.',
    };
  }

  const db = await PGlite.create({ extensions: { citext } });
  const socketServer = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 8 });
  await socketServer.start();
  return {
    server: {
      connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
      port,
      engine: 'pglite',
      async stop() {
        await socketServer.stop().catch(() => {});
        await db.close().catch(() => {});
      },
    },
    reason: null,
  };
}

async function waitForReady(pg, connectionString, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('PostgreSQL did not become ready.');
}

/** Apply the SHIPPED Postgres migration set — the real runner, not a copy. */
export async function migrate(connectionString) {
  const runner = join(REPO, 'packages', 'worker', 'migrate-postgres.mjs');
  await runTool(process.execPath, [runner, `--connection-string=${connectionString}`], { cwd: REPO });
}
