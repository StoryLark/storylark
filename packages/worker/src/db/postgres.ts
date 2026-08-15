import { Pool, type QueryResultRow } from 'pg';
import type { Database, PreparedStatement, ConflictInsert } from './types';

/**
 * Postgres driver (AB#7399) — covers Azure Database for PostgreSQL and AWS
 * RDS/Aurora with one implementation. Mirrors D1's chainable prepare/bind
 * API so route code, written against the reference D1 driver, needs no
 * changes: only `?` placeholder order matters, translated here to `$1..$n`.
 *
 * `email`/`username` columns use Postgres's `citext` extension (enabled in
 * the postgres migrations) to match SQLite's `COLLATE NOCASE` semantics —
 * case-insensitive comparisons work identically with no query changes.
 */
export function postgresDatabase(connectionString: string): Database & ConflictInsert & { close(): Promise<void> } {
  const pool = new Pool({ connectionString });

  function toPositional(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  function prepare(sql: string): PreparedStatement {
    let boundValues: unknown[] = [];
    const stmt: PreparedStatement = {
      bind(...values: unknown[]) {
        boundValues = values;
        return stmt;
      },
      async first<T = unknown>() {
        const res = await pool.query<QueryResultRow>(toPositional(sql), boundValues);
        return (res.rows[0] as T) ?? null;
      },
      async run() {
        const res = await pool.query(toPositional(sql), boundValues);
        return { success: true, meta: { changes: res.rowCount ?? 0 } };
      },
      async all<T = unknown>() {
        const res = await pool.query<QueryResultRow>(toPositional(sql), boundValues);
        return { results: res.rows as T[] };
      },
    };
    return stmt;
  }

  return {
    prepare,
    async insertIgnore(table, columns, values, conflictColumns) {
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      await pool.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${conflictColumns.join(', ')}) DO NOTHING`,
        values
      );
    },
    async close() {
      await pool.end();
    },
  };
}
