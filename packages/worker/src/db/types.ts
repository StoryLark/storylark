// Database seam (AB#7399): every route talks to this interface, never to a
// specific cloud's SQL binding. It mirrors D1's own chainable shape
// (prepare -> bind -> first/run/all) so the reference Cloudflare driver is a
// zero-cost pass-through and existing route code needed no call-site changes.

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: { changes?: number; last_row_id?: number | string } }>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

export interface Database {
  prepare(sql: string): PreparedStatement;
}

/**
 * Insert a row and silently do nothing on a conflict, portably. D1/SQLite
 * spells this `INSERT OR IGNORE`; Postgres needs `ON CONFLICT ... DO NOTHING`.
 * Route code calls this instead of writing the dialect-specific SQL inline —
 * the two implementations below are the only places that difference lives.
 */
export interface ConflictInsert {
  insertIgnore(table: string, columns: string[], values: unknown[], conflictColumns: string[]): Promise<void>;
}
