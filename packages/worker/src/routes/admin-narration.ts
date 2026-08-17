/**
 * The narration queue's HTTP surface (AB#7412 — plan §8, item 4).
 *
 * Two very different callers, one router:
 *
 *   • **The portal**, with an admin session, asking "what is queued, what is
 *     running, what failed and why, and roughly how long is left". Read-mostly.
 *   • **A worker** — `packages/pipeline/narrate.mjs` — with `X-Admin-Key`,
 *     claiming jobs, reporting results, reporting failures. Headless by
 *     definition, exactly like `POST /api/admin/publish` and the theme import,
 *     so it gets the same two-door gate those already use.
 *
 * Mounted at the `/api/admin` prefix but registered BEFORE `adminContent`, and
 * that order is load-bearing for the same reason index.ts already records for
 * `adminThemes`: Hono composes matching middleware in registration order, and
 * `adminContent` gates the whole prefix with a session-only `requireAdmin()`.
 * Mounted after it, the worker's key door would answer 401 whatever key it sent.
 *
 * ── Nothing here narrates ───────────────────────────────────────────────────
 * No route in this file synthesises audio, and none ever will while the model
 * lives in the pipeline. `GET /api/admin/narration` says so in the response —
 * `runtime.canProcessInDeployment` with the platform's own reason and the
 * command that does the work — because a queue that silently never drains is
 * worse than no queue at all.
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AppContext } from '../types';
import { requireAdmin } from '../lib/session';
import { ID_RE, readManifest } from '../lib/content';
import { recordPublish } from '../lib/notify';
import {
  cancelJob,
  chaptersNeedingNarration,
  claimJobs,
  completeJob,
  enqueue,
  failJob,
  narrationRuntime,
  notifyBatchFinished,
  queueView,
  retryJob,
} from '../lib/narration';

export const adminNarration = new Hono<AppContext>();

function hasAdminKey(c: Context<AppContext>): boolean {
  return !!c.env.ADMIN_KEY && c.req.header('x-admin-key') === c.env.ADMIN_KEY;
}

function requireAdminOrKey() {
  return async (c: Context<AppContext>, next: Next) => {
    if (hasAdminKey(c)) return next();
    return requireAdmin()(c, next);
  };
}

adminNarration.use('/narration', requireAdminOrKey());
adminNarration.use('/narration/*', requireAdminOrKey());

function actor(c: Context<AppContext>): string {
  const user = c.get('user');
  return user?.email || user?.username || 'cli';
}

/**
 * GET /api/admin/narration — everything the portal polls.
 *
 * One request answers the whole card: which runtime can actually do the work,
 * how many jobs are in each state, how much text is left, a time estimate
 * measured from this deployment's own completed jobs, the recent job list and
 * the batches they belong to.
 */
adminNarration.get('/narration', async (c) => {
  const limit = Number(c.req.query('limit') ?? 100);
  return c.json(await queueView(c.env, Number.isFinite(limit) ? limit : 100));
});

/**
 * POST /api/admin/narration/enqueue — queue work.
 *
 * `{ staleOnly?: true, bookIds?: [...], chapters?: [{bookId, chapterId}] }`
 *
 * Defaults to everything in the library whose audio is missing or no longer
 * matches its text — which is the whole library right after a bulk import, and
 * exactly one chapter after a typo fix. `staleOnly: false` re-narrates
 * regardless, which is what changing the narrator voice needs.
 */
adminNarration.post('/narration/enqueue', async (c) => {
  const store = c.env.CONTENT_STORE;
  if (!store) {
    return c.json(
      {
        error: 'no_content_store',
        message:
          'This deployment has no writable content storage bound, so it cannot read its own library to work out what needs narrating.',
      },
      501
    );
  }
  const body = await c.req.json<{
    staleOnly?: boolean;
    bookIds?: unknown;
    chapters?: unknown;
    label?: string;
  }>().catch(() => ({}) as Record<string, never>);

  const bookIds = Array.isArray(body.bookIds) ? body.bookIds.map(String).filter((id) => ID_RE.test(id)) : undefined;
  const chapters = Array.isArray(body.chapters)
    ? body.chapters
        .map((raw) => raw as { bookId?: unknown; chapterId?: unknown })
        .filter((x) => typeof x.bookId === 'string' && typeof x.chapterId === 'string')
        .map((x) => ({ bookId: String(x.bookId), chapterId: String(x.chapterId) }))
    : undefined;

  const manifest = await readManifest(store);
  const items = chaptersNeedingNarration(manifest, { staleOnly: body.staleOnly !== false, bookIds, chapters });
  if (items.length === 0) {
    return c.json({
      ok: true,
      queued: 0,
      batchId: null,
      message:
        body.staleOnly === false
          ? 'Nothing matched — check the book and chapter ids.'
          : 'Nothing needs narrating: every chapter that matched already has audio matching its current text.',
      runtime: narrationRuntime(c.env),
    });
  }
  try {
    const result = await enqueue(c.env, items, {
      requestedBy: actor(c),
      label: body.label ?? `queued from the portal: ${items.length} chapter${items.length === 1 ? '' : 's'}`,
    });
    return c.json({
      ok: true,
      queued: result.total,
      created: result.queued,
      requeued: result.requeued,
      batchId: result.batchId,
      runtime: narrationRuntime(c.env),
    });
  } catch (err) {
    return c.json(
      {
        error: 'queue_unavailable',
        message: `The narration queue tables are not in this deployment's database yet (${(err as Error).message}). Apply the migrations and try again.`,
      },
      501
    );
  }
});

/**
 * POST /api/admin/narration/claim — a worker asks for work.
 *
 * `{ worker: "runner-1", max: 4 }` → the jobs it now owns, each with the public
 * URL of the chapter JSON to narrate. Claims are atomic (see `claimJobs()`), so
 * several workers can drain one queue in parallel without coordinating.
 */
adminNarration.post('/narration/claim', async (c) => {
  const body = await c.req.json<{ worker?: string; max?: number }>().catch(() => ({}) as { worker?: string; max?: number });
  const worker = typeof body.worker === 'string' && body.worker.trim() ? body.worker.trim().slice(0, 120) : 'unnamed-worker';
  const max = Number.isFinite(body.max) ? Number(body.max) : 1;
  try {
    const jobs = await claimJobs(c.env, worker, max);
    // Same-origin content (AB#7395): with no CONTENT_ORIGIN the chapter JSON
    // is public on the app's own origin, served by this very Worker — so the
    // claim hands out that URL rather than a null a runner cannot fetch.
    const origin = (c.env.CONTENT_ORIGIN || c.env.APP_ORIGIN || '').replace(/\/+$/, '');
    return c.json({
      ok: true,
      worker,
      jobs: jobs.map((job) => ({
        ...job,
        /** Where the published blocks for this exact content hash live. Public. */
        contentKey: `books/${job.bookId}/chapters/${job.chapterId}.${job.contentHash}.json`,
        contentUrl: origin ? `${origin}/books/${job.bookId}/chapters/${job.chapterId}.${job.contentHash}.json` : null,
        /** Where the worker must upload what it produces. */
        audioKey: `books/${job.bookId}/audio/${job.chapterId}.${job.contentHash}.mp3`,
        timingsKey: `books/${job.bookId}/timings/${job.chapterId}.${job.contentHash}.json`,
      })),
    });
  } catch (err) {
    return c.json({ error: 'queue_unavailable', message: (err as Error).message }, 501);
  }
});

/**
 * POST /api/admin/narration/jobs/:id/complete — a worker reports success.
 *
 * The worker has already uploaded the audio and timings under the content-hashed
 * keys the claim named. This is what makes them visible: the manifest entry is
 * updated and `audioStale` cleared, in the deployment, which is the only place
 * that owns the manifest. See `completeJob()` for the two refusals.
 */
adminNarration.post('/narration/jobs/:id/complete', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    audio?: string;
    timings?: string;
    durationMs?: number;
    voices?: Record<string, { audio: string; timings: string }>;
    elapsedMs?: number;
    contentHash?: string;
  }>().catch(() => null);
  if (!body || typeof body.audio !== 'string' || typeof body.timings !== 'string') {
    return c.json({ error: 'bad_request', message: '`audio` and `timings` storage keys are required.' }, 400);
  }
  const outcome = await completeJob(c.env, c.env.CONTENT_STORE ?? null, id, {
    audio: body.audio,
    timings: body.timings,
    durationMs: Number(body.durationMs ?? 0),
    voices: body.voices,
    elapsedMs: Number(body.elapsedMs ?? 0),
    contentHash: body.contentHash,
  });
  if (!outcome.ok) {
    return c.json(
      { error: outcome.error, message: outcome.message },
      outcome.error === 'not_found' ? 404 : outcome.error === 'no_content_store' ? 501 : 409
    );
  }

  // The library version always moves so readers re-fetch and hear the new
  // audio; nothing is announced, because the words did not change. Same
  // correction rule the portal's edits use — one implementation, in notify.ts.
  const notified = await recordPublish(c.env, (p) => c.executionCtx.waitUntil(p), outcome.libraryVersion, false);

  let batch: Awaited<ReturnType<typeof notifyBatchFinished>> | null = null;
  if (outcome.batchFinished) batch = await notifyBatchFinished(c.env, outcome.batchId);

  return c.json({ ok: true, job: outcome.job, libraryVersion: outcome.libraryVersion, notified, batchFinished: outcome.batchFinished, batch });
});

/** POST /api/admin/narration/jobs/:id/fail — a worker reports why it could not. */
adminNarration.post('/narration/jobs/:id/fail', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ error?: string }>().catch(() => ({}) as { error?: string });
  await failJob(c.env, id, String(body.error ?? 'The worker reported a failure with no message.'));
  // A failure can be the last outstanding job in a batch. The operator still
  // wants to hear that the batch is over — with the failure count in it.
  const row = await c.env.DB.prepare('SELECT batch_id FROM narration_jobs WHERE id = ?').bind(id).first<{ batch_id: string }>();
  let batch: Awaited<ReturnType<typeof notifyBatchFinished>> | null = null;
  if (row?.batch_id) {
    const outstanding = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM narration_jobs WHERE batch_id = ? AND status IN ('pending', 'running')"
    )
      .bind(row.batch_id)
      .first<{ n: number }>();
    if (Number(outstanding?.n ?? 0) === 0) batch = await notifyBatchFinished(c.env, row.batch_id);
  }
  return c.json({ ok: true, batch });
});

/** POST /api/admin/narration/jobs/:id/retry — put a failed job back in the queue. */
adminNarration.post('/narration/jobs/:id/retry', async (c) => {
  const ok = await retryJob(c.env, c.req.param('id'));
  return ok
    ? c.json({ ok: true })
    : c.json({ error: 'not_retryable', message: 'Only a failed or cancelled job can be retried.' }, 409);
});

/** DELETE /api/admin/narration/jobs/:id — drop a job that has not started. */
adminNarration.delete('/narration/jobs/:id', async (c) => {
  const ok = await cancelJob(c.env, c.req.param('id'));
  return ok
    ? c.json({ ok: true, cancelled: c.req.param('id') })
    : c.json({ error: 'not_cancellable', message: 'Only a pending job can be cancelled; a running one has to fail or finish.' }, 409);
});
