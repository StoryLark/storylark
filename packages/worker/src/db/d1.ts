import type { Database, ConflictInsert } from './types';

/**
 * The Cloudflare reference driver. D1Database's prepare/bind/first/run/all
 * shape already matches the Database interface exactly, so this is a
 * zero-overhead identity cast — existing Cloudflare deployments see no
 * behavior change from the seam's introduction.
 */
export function d1Database(db: D1Database): Database & ConflictInsert {
  const database = db as unknown as Database;
  return {
    prepare: database.prepare.bind(database),
    async insertIgnore(table, columns, values, _conflictColumns) {
      const placeholders = columns.map(() => '?').join(', ');
      await database
        .prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
        .bind(...values)
        .run();
    },
  };
}
