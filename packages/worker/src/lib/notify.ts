/**
 * Library-version bookkeeping and the push fan-out (AB#7420).
 *
 * Extracted from routes/admin.ts's POST /publish so the portal's editing path
 * uses the exact same code rather than a second copy of "how readers find out
 * something changed". Two callers, one implementation:
 *
 *   • POST /api/admin/publish — the CLI pipeline's final step.
 *   • The portal's chapter save / revert (routes/admin-content.ts).
 *
 * ── The correction rule (plan §3) ───────────────────────────────────────────
 * A typo fix and a brand-new chapter are not the same event, and conflating
 * them is why "every small correction pings every reader's phone" was flagged
 * as a thing to decide at build time. They are separated here into the two
 * effects that were previously one:
 *
 *   1. `manifest_version` in the database ALWAYS moves. It is the freshness
 *      probe `/api/library/version` answers, and it is the only thing that
 *      makes a reader re-fetch the manifest at all. A correction that skipped
 *      it would be a correction nobody ever receives — the fix would sit in
 *      storage behind a manifest still pointing at the old content hash.
 *   2. The push fan-out only happens when `announce` is true. A correction
 *      updates silently; a publication wakes the phone.
 *
 * The in-app "new content" badge is governed by the manifest's own
 * `announceVersion` (see lib/content.ts), which is the client-side half of the
 * same distinction.
 */

import type { Env } from '../types';
import type { Database } from '../db/types';
import { sendPush } from './vapid';

export interface PublishNotifyResult {
  version: number;
  announced: boolean;
  subscriptions: number;
}

/**
 * Record a new library version and, unless this was a correction, wake every
 * push subscription. The fan-out is handed to `waitUntil` so the caller's
 * response doesn't wait on it.
 */
export async function recordPublish(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  version: number,
  announce: boolean
): Promise<PublishNotifyResult> {
  await env.DB.prepare('UPDATE library_state SET manifest_version = ?, updated_at = ? WHERE id = 1')
    .bind(version, Date.now())
    .run();

  if (!announce) return { version, announced: false, subscriptions: 0 };

  const { results } = await env.DB.prepare('SELECT endpoint, failed_count FROM push_subscriptions').all<{
    endpoint: string;
    failed_count: number;
  }>();

  // VAPID contact subject — derived from the app origin's registrable domain
  // (app.example.com → example.com) so it stays brand-neutral.
  const subject = `mailto:noreply@${new URL(env.APP_ORIGIN).hostname.replace(/^app\./, '')}`;
  waitUntil(fanOut(env, results, subject));
  return { version, announced: true, subscriptions: results.length };
}

export async function fanOut(
  env: Env,
  subs: { endpoint: string; failed_count: number }[],
  subject: string
): Promise<void> {
  const BATCH = 50;
  for (let i = 0; i < subs.length; i += BATCH) {
    await Promise.all(
      subs.slice(i, i + BATCH).map(async (s) => {
        try {
          const status = await sendPush(s.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, subject);
          if (status === 404 || status === 410) {
            await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(s.endpoint).run();
          } else if (status >= 400) {
            await bumpFailure(env.DB, s.endpoint, s.failed_count);
          }
        } catch {
          await bumpFailure(env.DB, s.endpoint, s.failed_count);
        }
      })
    );
  }
}

async function bumpFailure(db: Database, endpoint: string, current: number): Promise<void> {
  if (current + 1 >= 5) {
    await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
  } else {
    await db.prepare('UPDATE push_subscriptions SET failed_count = failed_count + 1 WHERE endpoint = ?').bind(endpoint).run();
  }
}
