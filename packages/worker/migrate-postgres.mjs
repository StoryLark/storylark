#!/usr/bin/env node
// Applies migrations-postgres/*.sql in order, tracked in a schema_migrations
// table. Mirrors what `wrangler d1 migrations apply` does for D1 — this is
// the equivalent for the Postgres driver (Azure/AWS). Usage:
//   node migrate-postgres.mjs --connection-string "$DATABASE_URL"
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.find((a) => a.startsWith('--connection-string='));
const connectionString = arg ? arg.split('=').slice(1).join('=') : process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Usage: node migrate-postgres.mjs --connection-string=<url>  (or set DATABASE_URL)');
  process.exit(1);
}

const dir = join(__dirname, 'migrations-postgres');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const client = new pg.Client({ connectionString });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
const { rows } = await client.query('SELECT name FROM schema_migrations');
const applied = new Set(rows.map((r) => r.name));

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = readFileSync(join(dir, file), 'utf8');
  console.log(`Applying ${file}...`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

console.log('Postgres migrations up to date.');
await client.end();
