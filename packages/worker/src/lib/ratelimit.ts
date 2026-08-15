/**
 * Fixed-window rate limiting backed by the `rate_limits` table (0005).
 * Callers pick a bucket key (typically "<endpoint>:<ip>") plus a limit and a
 * window in milliseconds; this reads the bucket, resets it if the window has
 * elapsed since window_start, otherwise increments the count and compares it
 * against the limit. Every path here — including any D1 error — fails OPEN
 * (returns true), so a database hiccup degrades to "unthrottled" rather than
 * locking everyone out of sign-in.
 */
import type { Database } from '../db/types';

export async function rateLimit(db: Database, bucket: string, limit: number, windowMs: number): Promise<boolean> {
  try {
    const now = Date.now();
    const row = await db
      .prepare('SELECT count, window_start FROM rate_limits WHERE bucket = ?')
      .bind(bucket)
      .first<{ count: number; window_start: number }>();

    if (!row || now - row.window_start >= windowMs) {
      await db
        .prepare(
          `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
           ON CONFLICT (bucket) DO UPDATE SET count = 1, window_start = excluded.window_start`
        )
        .bind(bucket, now)
        .run();
      return true;
    }

    if (row.count < limit) {
      await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE bucket = ?').bind(bucket).run();
      return true;
    }

    return false;
  } catch {
    return true;
  }
}
