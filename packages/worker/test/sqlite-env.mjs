// A real database and a real content store, for tests that drive the REAL Hono
// app over real HTTP (AB#7412).
//
// ── Why node:sqlite rather than a stub ──────────────────────────────────────
// The alternative was a hand-written object that pretends to be a database, and
// it would have proved nothing: the interesting parts of the narration queue are
// SQL — a conditional `UPDATE … WHERE status = 'pending'` deciding who wins a
// claim, `GROUP BY status`, a `LEFT JOIN` producing per-batch counts, and the
// migration file itself being valid DDL. A fake would have "passed" all of them
// without executing one.
//
// `node:sqlite` (Node 22.5+, and this repo runs Node 24) is the same engine D1
// is built on, so these tests execute the actual shipped `migrations/*.sql` and
// the actual shipped queries. What they cannot cover is Postgres dialect
// differences — that is what packages/worker/test/node-http-readonly.test.mjs
// exists for, against a real Postgres server.
//
// ── The seam ────────────────────────────────────────────────────────────────
// packages/worker/src/db/types.ts is deliberately D1-shaped (prepare → bind →
// first/run/all), and the D1 driver is a pass-through, so mapping it onto
// node:sqlite is a dozen lines with no translation layer to get wrong.

import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localContentStore } from '../../../platforms/azure/content-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');

/** Apply every shipped D1 migration, in order, to a fresh in-memory database. */
export async function sqliteDatabase() {
  const db = new DatabaseSync(':memory:');
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    db.exec(await readFile(join(MIGRATIONS, file), 'utf8'));
  }
  return { db, driver: seam(db), migrations: files };
}

function seam(db) {
  return {
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...values) {
          bound = values.map(normalise);
          return stmt;
        },
        async first() {
          return db.prepare(sql).get(...bound) ?? null;
        },
        async run() {
          const info = db.prepare(sql).run(...bound);
          return { success: true, meta: { changes: Number(info.changes ?? 0), last_row_id: info.lastInsertRowid } };
        },
        async all() {
          return { results: db.prepare(sql).all(...bound) };
        },
      };
      return stmt;
    },
    async insertIgnore(table, columns, values, conflictColumns) {
      db.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ` +
          `ON CONFLICT (${conflictColumns.join(', ')}) DO NOTHING`
      ).run(...values.map(normalise));
    },
  };
}

/** node:sqlite binds only null/number/bigint/string/Uint8Array. */
function normalise(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/**
 * A whole test deployment: the real app, a real database, a real content store
 * on disk, and a `fetch` that goes through the real router.
 *
 * `executionCtx.waitUntil` is the same polyfill platforms/azure/server.mjs uses,
 * so background work (the push fan-out) behaves as it does on the Node entry.
 */
export async function testDeployment(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'storylark-api-'));
  const { db, driver } = await sqliteDatabase();
  const { app } = await import('../src/index.ts');

  const env = {
    DB: driver,
    CONTENT_STORE: localContentStore(dir),
    BRAND: 'storylark-test',
    APP_ORIGIN: 'https://app.example.test',
    CONTENT_ORIGIN: 'https://content.example.test',
    MAIL_FROM: 'noreply@example.test',
    APP_NAME: 'StoryLark Test',
    ADMIN_KEY: 'test-admin-key',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    RESEND_API_KEY: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    GITHUB_REPO: '',
    GITHUB_DEPLOY_TOKEN: '',
    ADMIN_EMAIL: '',
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    ...overrides,
  };
  const executionCtx = { waitUntil(p) { void Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };

  async function call(method, path, body, headers = {}) {
    const init = { method, headers: { 'X-Admin-Key': env.ADMIN_KEY, ...headers } };
    if (body !== undefined) {
      if (body instanceof Uint8Array) {
        init.body = body;
        init.headers['Content-Type'] ??= 'application/zip';
      } else {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
      }
    }
    const res = await app.fetch(new Request(`https://app.example.test${path}`, init), env, executionCtx);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  return {
    dir,
    env,
    db,
    call,
    manifest: async () => JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
    async close() {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal, valid chapter. Front matter plus one paragraph is the whole rule. */
export function chapterMarkdown(title, body = 'A paragraph of perfectly ordinary prose, long enough to be a chapter.') {
  return `---\ntitle: ${title}\n---\n\n${body}\n`;
}
