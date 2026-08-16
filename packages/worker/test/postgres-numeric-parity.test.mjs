// Regression test for the cross-platform response-shape bug (§1 of the
// admin-content-auth-plan): Postgres returns BIGINT/COUNT(*) columns as
// strings by default, D1/SQLite always returns a plain number. Confirmed
// live earlier this session: Azure's /api/admin/status reported
// pushSubscriptions as "0" while Cloudflare reported 0, same brand, same
// data. Fixed in packages/worker/src/db/postgres.ts by registering a type
// parser for OID 20 (bigint) once, for every bigint column, not per-query.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// Importing postgres.ts registers the parser as a module-level side effect.
// Doing it here, once, before any test runs, proves the actual shipped
// module does the registration — not a copy of the fix living only in this
// test — and avoids a test-ordering race against that side effect.
await import('../src/db/postgres.ts');

test('pg bigint (OID 20) type parser is registered to return a plain number', () => {
  const parser = pg.types.getTypeParser(20);
  assert.equal(typeof parser('0'), 'number', 'bigint "0" must parse to a number, matching D1');
  assert.equal(parser('0'), 0);
  assert.equal(parser('42'), 42);
  assert.equal(typeof parser('42'), 'number');
});

test('a D1-shaped COUNT(*) result and a Postgres-shaped one agree in type', () => {
  // D1's own driver (d1.ts) is a pass-through identity cast — whatever
  // D1Database.prepare().first() returns is exactly what callers see, and
  // D1/SQLite has no bigint-vs-number distinction: COUNT(*) is always a
  // plain JS number there. This asserts the Postgres side now matches that,
  // for the exact query shape routes/admin.ts's /status endpoint uses.
  const parser = pg.types.getTypeParser(20);
  const postgresCount = parser('0'); // what pool.query() now hands back for COUNT(*)
  const d1Count = 0; // what a D1Database.prepare('SELECT COUNT(*)...').first() returns natively
  assert.equal(typeof postgresCount, typeof d1Count, 'both drivers must return the same JS type for a count');
  assert.equal(postgresCount, d1Count);
});
