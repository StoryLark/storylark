/**
 * The bulk narration queue (AB#7412 — plan §8, item 4).
 *
 * The plan calls this "the genuinely expensive piece of serving a large
 * publisher", and then says the thing that actually decides the design:
 *
 *   > Push hardest on the narration queue, and not for large publishers. It is
 *   > needed the first time *anyone* publishes fifty stories at once.
 *
 * ── The constraint, stated rather than worked around ────────────────────────
 * **No StoryLark deployment can narrate.** Not "Cloudflare can't and Azure can"
 * — neither can, and the difference between them is only the reason:
 *
 *   • A Cloudflare Worker cannot run the Kokoro model at all. No filesystem for
 *     the ~90MB weights, no native ONNX runtime, no ffmpeg to stitch chunks, and
 *     a CPU budget measured in seconds against a job measured in minutes.
 *   • The Node entry (platforms/azure/server.mjs) *could* host a model, but does
 *     not: its dependencies are hono, pg and the blob client. TTS, force
 *     alignment and stitching live in `packages/pipeline`, together with ffmpeg
 *     and the storage credentials, because that is where narration has always
 *     actually happened.
 *
 * So the deployment owns the QUEUE and the pipeline owns the WORK. That is not
 * a limitation being hidden behind a spinner: every status this module reports
 * says which runtime is missing and what command supplies it. The single-book
 * case already behaves this way — a portal edit marks `audioStale` and tells the
 * operator the next pipeline run will re-narrate — and this is that same honesty
 * scaled to a catalogue, with the difference that the work is now *tracked*
 * instead of being an implicit promise about a future publish.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *   enqueue → pending → (worker claims) → running → done | failed
 *
 * A worker is `packages/pipeline/narrate.mjs`. It claims jobs over HTTP with
 * ADMIN_KEY, reads each chapter's published blocks from the public content
 * origin, synthesises, uploads the audio under the same content-hashed keys
 * publish.mjs writes, and reports back — at which point the deployment (which is
 * the only thing holding a writable content store on Cloudflare) updates the
 * manifest entry and clears `audioStale`.
 *
 * ── Everything degrades, nothing crashes ────────────────────────────────────
 * A deployment whose database has not run migration 0008 has no queue tables.
 * That is a NORMAL state during an update — platforms/azure/server.mjs installs
 * storylark-worker from npm and can legitimately be a version ahead of its
 * schema for a few seconds — so every read here answers `available: false` with
 * the migration command instead of throwing a 500 at the portal.
 */

import type { Env } from '../types';
import type { ChapterEntry } from '../content-types';
import type { ContentStore } from './content-store';
import { announceVersionOf, findBook, findChapter, key, readManifest, writeManifest } from './content';
import { sendMail } from './resend';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface NarrationJob {
  id: string;
  batchId: string;
  bookId: string;
  chapterId: string;
  contentHash: string;
  status: JobStatus;
  attempts: number;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  worker: string | null;
  error: string | null;
  charLength: number;
  durationMs: number;
  elapsedMs: number;
  requestedBy: string | null;
}

interface JobRow {
  id: string;
  batch_id: string;
  book_id: string;
  chapter_id: string;
  content_hash: string;
  status: string;
  attempts: number;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  worker: string | null;
  error: string | null;
  char_length: number;
  duration_ms: number;
  elapsed_ms: number;
  requested_by: string | null;
}

function toJob(row: JobRow): NarrationJob {
  return {
    id: row.id,
    batchId: row.batch_id,
    bookId: row.book_id,
    chapterId: row.chapter_id,
    contentHash: row.content_hash,
    status: row.status as JobStatus,
    attempts: Number(row.attempts ?? 0),
    enqueuedAt: Number(row.enqueued_at ?? 0),
    startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    worker: row.worker ?? null,
    error: row.error ?? null,
    charLength: Number(row.char_length ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
    elapsedMs: Number(row.elapsed_ms ?? 0),
    requestedBy: row.requested_by ?? null,
  };
}

/**
 * A job a worker has held for longer than this is assumed dead and returned to
 * `pending`. Long, because a genuinely slow chapter on a cold model is minutes,
 * not seconds — the failure this guards against is a killed CI runner, not a
 * slow one.
 */
export const STALE_CLAIM_MS = 30 * 60 * 1000;

/** How many completed jobs the throughput estimate averages over. */
const THROUGHPUT_SAMPLE = 25;

/* ────────────────────────────────────────────────────────────────────────────
 * Where narration can actually happen
 * ──────────────────────────────────────────────────────────────────────────── */

export interface NarrationRuntime {
  platform: 'cloudflare' | 'node';
  /**
   * Always false today, on BOTH platforms, and the field exists so the portal
   * renders the truth rather than a hard-coded sentence that would silently
   * become a lie the day an in-deployment narrator ships.
   */
  canProcessInDeployment: false;
  /** Why not, in this platform's own terms. Shown verbatim in the portal. */
  reason: string;
  /** What the operator runs to drain the queue. */
  runCommand: string;
  /** Set only when the deployment holds no key a worker could authenticate with. */
  workerAuthConfigured: boolean;
}

export function narrationRuntime(env: Env): NarrationRuntime {
  const platform =
    typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers' ? 'cloudflare' : 'node';
  const reason =
    platform === 'cloudflare'
      ? 'A Cloudflare Worker cannot run the narration model: there is no filesystem for the ~90MB weights, no native ONNX runtime, no ffmpeg to stitch the audio, and a CPU budget measured in seconds against a job measured in minutes. Jobs queue here and are processed by the pipeline.'
      : 'This Node deployment holds the queue but ships no narration model — TTS, force alignment and stitching live in packages/pipeline, alongside ffmpeg and the storage credentials, which is where narration has always run. Jobs queue here and are processed by the pipeline.';
  return {
    platform,
    canProcessInDeployment: false,
    reason,
    runCommand: 'node packages/pipeline/narrate.mjs --brand <brand-id>',
    workerAuthConfigured: !!env.ADMIN_KEY,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Enqueue
 * ──────────────────────────────────────────────────────────────────────────── */

export interface EnqueueItem {
  bookId: string;
  chapterId: string;
  contentHash: string;
  charLength?: number;
}

export interface EnqueueResult {
  batchId: string;
  queued: number;
  requeued: number;
  total: number;
}

/**
 * Enqueue narration for a set of chapters.
 *
 * De-duplication is by (book, chapter) against LIVE work only: a chapter that
 * already has a `pending` job has that job updated to the new content hash
 * rather than gaining a second one, because narrating the same chapter twice
 * with the older text is pure waste. A chapter whose job is already `running`
 * gets a fresh pending row — the running worker is synthesising text that has
 * since changed, and its completion will be refused on the hash check, so the
 * new row is the one that produces usable audio.
 *
 * Deliberately not `insertIgnore()`: that needs a unique index, and the index
 * this would want is a partial one (`WHERE status IN ('pending','running')`)
 * whose ON CONFLICT target is spelled differently in SQLite and Postgres. Two
 * plain statements are portable and are what the seam already supports.
 */
export async function enqueue(
  env: Env,
  items: EnqueueItem[],
  opts: { requestedBy: string; label?: string; batchId?: string }
): Promise<EnqueueResult> {
  const now = Date.now();
  const batchId = opts.batchId ?? `nb_${now.toString(36)}_${randomSuffix()}`;
  let queued = 0;
  let requeued = 0;

  for (const item of items) {
    const updated = await env.DB.prepare(
      `UPDATE narration_jobs
         SET content_hash = ?, char_length = ?, enqueued_at = ?, batch_id = ?, requested_by = ?, error = NULL
       WHERE book_id = ? AND chapter_id = ? AND status = 'pending'`
    )
      .bind(
        item.contentHash,
        item.charLength ?? 0,
        now,
        batchId,
        opts.requestedBy,
        item.bookId,
        item.chapterId
      )
      .run();
    if ((updated.meta?.changes ?? 0) > 0) {
      requeued++;
      continue;
    }
    await env.DB.prepare(
      `INSERT INTO narration_jobs
         (id, batch_id, book_id, chapter_id, content_hash, status, attempts, enqueued_at, char_length, duration_ms, elapsed_ms, requested_by)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, 0, 0, ?)`
    )
      .bind(
        `nj_${now.toString(36)}_${randomSuffix()}`,
        batchId,
        item.bookId,
        item.chapterId,
        item.contentHash,
        now,
        item.charLength ?? 0,
        opts.requestedBy
      )
      .run();
    queued++;
  }

  if (queued + requeued > 0) {
    await env.DB.prepare(
      'INSERT INTO narration_batches (id, created_at, created_by, label, total, notified_at) VALUES (?, ?, ?, ?, ?, NULL)'
    )
      .bind(batchId, now, opts.requestedBy, opts.label ?? null, queued + requeued)
      .run();
  }
  return { batchId, queued, requeued, total: queued + requeued };
}

/**
 * Everything in a manifest that needs narrating, as enqueue items.
 *
 * `staleOnly` (the default) means "chapters whose audio is missing or no longer
 * matches the words" — which after a bulk import is every chapter, and after a
 * single typo fix is exactly one. Passing false re-narrates the whole library,
 * which is what changing the narrator voice needs.
 */
export function chaptersNeedingNarration(
  manifest: { books?: { id: string; chapters?: ChapterEntry[] }[] } | null,
  opts: { staleOnly?: boolean; bookIds?: string[]; chapters?: { bookId: string; chapterId: string }[] } = {}
): EnqueueItem[] {
  if (!manifest) return [];
  const staleOnly = opts.staleOnly !== false;
  const wanted = opts.chapters
    ? new Set(opts.chapters.map((c) => `${c.bookId}/${c.chapterId}`))
    : null;
  const bookFilter = opts.bookIds && opts.bookIds.length > 0 ? new Set(opts.bookIds) : null;

  const out: EnqueueItem[] = [];
  for (const book of manifest.books ?? []) {
    if (bookFilter && !bookFilter.has(book.id)) continue;
    for (const ch of book.chapters ?? []) {
      if (wanted && !wanted.has(`${book.id}/${ch.id}`)) continue;
      const needs = ch.hasAudio !== true || ch.audioStale === true;
      if (staleOnly && !needs) continue;
      out.push({
        bookId: book.id,
        chapterId: ch.id,
        contentHash: ch.contentHash,
        // Words, not characters, is what the manifest carries; the ratio is
        // stable enough for an estimate and costs no extra storage read.
        charLength: Math.round((ch.wordCount ?? 0) * 5.5),
      });
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading the queue
 * ──────────────────────────────────────────────────────────────────────────── */

export interface QueueView {
  available: boolean;
  /** Present when `available` is false: what to do about it. */
  message?: string;
  runtime: NarrationRuntime;
  counts: Record<JobStatus, number>;
  /** Characters still to synthesise (pending + running). */
  charsRemaining: number;
  /**
   * Seconds of wall clock, from MEASURED throughput on this deployment's own
   * completed jobs — never a constant. Null until something has completed,
   * because a number invented before the first measurement is exactly the
   * "import that appears to finish instantly" the plan warns about.
   */
  estimateSeconds: number | null;
  charsPerSecond: number | null;
  jobs: NarrationJob[];
  batches: { id: string; createdAt: number; createdBy: string | null; label: string | null; total: number; done: number; failed: number; pending: number; running: number; notifiedAt: number | null }[];
}

export async function queueView(env: Env, limit = 200): Promise<QueueView> {
  const runtime = narrationRuntime(env);
  const empty: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  try {
    const { results: counts } = await env.DB.prepare(
      'SELECT status, COUNT(*) AS n FROM narration_jobs GROUP BY status'
    ).all<{ status: string; n: number }>();
    for (const row of counts) {
      if (row.status in empty) empty[row.status as JobStatus] = Number(row.n);
    }

    const remaining = await env.DB.prepare(
      "SELECT COALESCE(SUM(char_length), 0) AS chars FROM narration_jobs WHERE status IN ('pending', 'running')"
    ).first<{ chars: number }>();

    const { results: samples } = await env.DB.prepare(
      `SELECT char_length, elapsed_ms FROM narration_jobs
        WHERE status = 'done' AND elapsed_ms > 0
        ORDER BY finished_at DESC LIMIT ${THROUGHPUT_SAMPLE}`
    ).all<{ char_length: number; elapsed_ms: number }>();
    const sampledChars = samples.reduce((n, s) => n + Number(s.char_length ?? 0), 0);
    const sampledMs = samples.reduce((n, s) => n + Number(s.elapsed_ms ?? 0), 0);
    const charsPerSecond = sampledMs > 0 && sampledChars > 0 ? sampledChars / (sampledMs / 1000) : null;
    const charsRemaining = Number(remaining?.chars ?? 0);

    const { results: jobRows } = await env.DB.prepare(
      `SELECT * FROM narration_jobs ORDER BY enqueued_at DESC LIMIT ${Math.max(1, Math.min(limit, 1000))}`
    ).all<JobRow>();

    const { results: batchRows } = await env.DB.prepare(
      `SELECT b.id, b.created_at, b.created_by, b.label, b.total, b.notified_at,
              SUM(CASE WHEN j.status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN j.status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN j.status = 'running' THEN 1 ELSE 0 END) AS running
         FROM narration_batches b LEFT JOIN narration_jobs j ON j.batch_id = b.id
        GROUP BY b.id, b.created_at, b.created_by, b.label, b.total, b.notified_at
        ORDER BY b.created_at DESC LIMIT 20`
    ).all<{
      id: string;
      created_at: number;
      created_by: string | null;
      label: string | null;
      total: number;
      notified_at: number | null;
      done: number | null;
      failed: number | null;
      pending: number | null;
      running: number | null;
    }>();

    return {
      available: true,
      runtime,
      counts: empty,
      charsRemaining,
      charsPerSecond,
      estimateSeconds: charsPerSecond ? Math.round(charsRemaining / charsPerSecond) : null,
      jobs: jobRows.map(toJob),
      batches: batchRows.map((b) => ({
        id: b.id,
        createdAt: Number(b.created_at ?? 0),
        createdBy: b.created_by ?? null,
        label: b.label ?? null,
        total: Number(b.total ?? 0),
        done: Number(b.done ?? 0),
        failed: Number(b.failed ?? 0),
        pending: Number(b.pending ?? 0),
        running: Number(b.running ?? 0),
        notifiedAt: b.notified_at === null || b.notified_at === undefined ? null : Number(b.notified_at),
      })),
    };
  } catch (err) {
    // Almost always "no such table": this deployment's database predates
    // migration 0008. Reported as a state with a fix, not as a 500.
    return {
      available: false,
      message: `The narration queue tables are not in this deployment's database yet (${(err as Error).message}). Apply the migrations — \`wrangler d1 migrations apply\` on Cloudflare, \`node migrate-postgres.mjs\` on Node/Azure — and this appears without any other change.`,
      runtime,
      counts: empty,
      charsRemaining: 0,
      estimateSeconds: null,
      charsPerSecond: null,
      jobs: [],
      batches: [],
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Claiming, completing, failing
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Hand a worker up to `max` jobs, atomically.
 *
 * The claim is a conditional UPDATE — `WHERE id = ? AND status = 'pending'` —
 * and the row count decides whether this worker got it. That is the one
 * primitive both drivers give identically (D1 reports `meta.changes`, Postgres
 * reports `rowCount` through the same field), so two workers racing for the same
 * job cannot both win, with no advisory locks and no `SELECT … FOR UPDATE` that
 * D1 does not have.
 *
 * Jobs a worker claimed and never finished are returned to the queue first. A
 * killed CI runner would otherwise pin its jobs in `running` forever, and the
 * queue would look busy while nothing was happening — which is worse than
 * slowness because it is indistinguishable from progress.
 */
export async function claimJobs(env: Env, worker: string, max: number): Promise<NarrationJob[]> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE narration_jobs
        SET status = 'pending', worker = NULL, started_at = NULL,
            error = 'Reclaimed: the worker that held this job stopped reporting.'
      WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`
  )
    .bind(now - STALE_CLAIM_MS)
    .run();

  const want = Math.max(1, Math.min(max, 50));
  const { results } = await env.DB.prepare(
    `SELECT * FROM narration_jobs WHERE status = 'pending' ORDER BY enqueued_at ASC LIMIT ${want * 2}`
  ).all<JobRow>();

  const claimed: NarrationJob[] = [];
  for (const row of results) {
    if (claimed.length >= want) break;
    const res = await env.DB.prepare(
      `UPDATE narration_jobs
          SET status = 'running', worker = ?, started_at = ?, attempts = attempts + 1, error = NULL
        WHERE id = ? AND status = 'pending'`
    )
      .bind(worker, now, row.id)
      .run();
    if ((res.meta?.changes ?? 0) > 0) {
      claimed.push(toJob({ ...row, status: 'running', worker, started_at: now, attempts: Number(row.attempts ?? 0) + 1 }));
    }
  }
  return claimed;
}

export interface CompletionInput {
  /** Storage key of the stitched audio, e.g. books/<book>/audio/<ch>.<hash>.mp3 */
  audio: string;
  /** Storage key of the word timings JSON. */
  timings: string;
  durationMs: number;
  /** Extra narrator voices, if the worker produced any. */
  voices?: Record<string, { audio: string; timings: string }>;
  /** How long the synthesis took, for the throughput estimate. */
  elapsedMs?: number;
  /** The hash the worker actually narrated — checked against the job's. */
  contentHash?: string;
}

export type CompletionOutcome =
  | { ok: true; job: NarrationJob; libraryVersion: number; batchFinished: boolean; batchId: string }
  | { ok: false; error: string; message: string };

/**
 * Record a finished job and clear the chapter's staleness in the manifest.
 *
 * The manifest write happens HERE, in the deployment, rather than in the worker,
 * for the same reason `saveChapter()` is the only writer of a chapter entry:
 * there is one place that knows the ordering rule (derived object first,
 * manifest last) and one place that bumps the library version. A worker that
 * wrote the manifest itself would be a second manifest writer racing the portal.
 *
 * Two refusals, both about not lying to readers:
 *   • a hash mismatch means the text moved while this was synthesising, so the
 *     audio does not match the words and must not be published as if it did;
 *   • a missing chapter means it was deleted mid-run.
 * Both mark the job failed with the reason rather than throwing.
 */
export async function completeJob(
  env: Env,
  store: ContentStore | null,
  jobId: string,
  input: CompletionInput
): Promise<CompletionOutcome> {
  const row = await env.DB.prepare('SELECT * FROM narration_jobs WHERE id = ?').bind(jobId).first<JobRow>();
  if (!row) return { ok: false, error: 'not_found', message: `No narration job "${jobId}".` };
  const job = toJob(row);
  if (job.status === 'done') {
    return { ok: false, error: 'already_done', message: `Job "${jobId}" was already completed.` };
  }
  if (input.contentHash && input.contentHash !== job.contentHash) {
    await failJob(
      env,
      jobId,
      `The chapter changed while it was being narrated (job was for content hash ${job.contentHash}, worker narrated ${input.contentHash}). The audio was discarded; a fresh job for the current text is what will produce usable narration.`
    );
    return {
      ok: false,
      error: 'stale_content_hash',
      message: `"${job.bookId}/${job.chapterId}" changed while it was being narrated. Nothing was published.`,
    };
  }
  if (!store) {
    return {
      ok: false,
      error: 'no_content_store',
      message:
        'This deployment has no writable content storage bound, so a completed narration cannot be written into the manifest. Bind an R2 bucket (Cloudflare) or set AZURE_STORAGE_CONNECTION_STRING / STORYLARK_LOCAL_CONTENT (Node).',
    };
  }

  const manifest = await readManifest(store);
  const book = manifest ? findBook(manifest, job.bookId) : undefined;
  const chapter = findChapter(book, job.chapterId);
  if (!manifest || !book || !chapter) {
    await failJob(env, jobId, `"${job.bookId}/${job.chapterId}" is no longer in the library — it was removed while this job was queued.`);
    return { ok: false, error: 'not_found', message: `"${job.bookId}/${job.chapterId}" is no longer in the library.` };
  }
  if (chapter.contentHash !== job.contentHash) {
    await failJob(
      env,
      jobId,
      `The chapter changed while it was being narrated (job was for ${job.contentHash}, the library now holds ${chapter.contentHash}). The audio was discarded.`
    );
    return {
      ok: false,
      error: 'stale_content_hash',
      message: `"${job.bookId}/${job.chapterId}" changed while it was being narrated. Nothing was published.`,
    };
  }

  chapter.audio = input.audio;
  chapter.timings = input.timings;
  chapter.hasAudio = true;
  chapter.audioDurationMs = Math.max(0, Math.round(input.durationMs || 0));
  chapter.audioStale = false;
  if (input.voices && Object.keys(input.voices).length > 0) chapter.voices = input.voices;
  // Ensure the chapter still points at its own source key, which is what tells
  // the portal it is round-trippable — narration never changes that, but a
  // manifest written by an older pipeline may not carry it.
  chapter.source ??= key.source(job.bookId, job.chapterId);

  const libraryVersion = (manifest.libraryVersion ?? 0) + 1;
  manifest.libraryVersion = libraryVersion;
  // Narration is never an announcement: the words readers are told about did not
  // change, the voice arrived. `libraryVersion` still moves so every reader
  // re-fetches and hears it — the same correction rule the portal's edits use.
  (manifest as { announceVersion?: number }).announceVersion = announceVersionOf(manifest);
  manifest.generatedAt = new Date().toISOString();
  await writeManifest(store, manifest);

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE narration_jobs
        SET status = 'done', finished_at = ?, duration_ms = ?, elapsed_ms = ?, error = NULL
      WHERE id = ?`
  )
    .bind(now, Math.max(0, Math.round(input.durationMs || 0)), Math.max(0, Math.round(input.elapsedMs ?? (job.startedAt ? now - job.startedAt : 0))), jobId)
    .run();

  const outstanding = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM narration_jobs WHERE batch_id = ? AND status IN ('pending', 'running')"
  )
    .bind(job.batchId)
    .first<{ n: number }>();

  return {
    ok: true,
    job: { ...job, status: 'done', finishedAt: now, durationMs: input.durationMs },
    libraryVersion,
    batchFinished: Number(outstanding?.n ?? 0) === 0,
    batchId: job.batchId,
  };
}

export async function failJob(env: Env, jobId: string, error: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE narration_jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?"
  )
    .bind(Date.now(), error.slice(0, 2000), jobId)
    .run();
}

/** Put a failed job back in the queue. The attempt counter is deliberately kept. */
export async function retryJob(env: Env, jobId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE narration_jobs SET status = 'pending', started_at = NULL, finished_at = NULL, worker = NULL, enqueued_at = ?
      WHERE id = ? AND status IN ('failed', 'cancelled')`
  )
    .bind(Date.now(), jobId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function cancelJob(env: Env, jobId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE narration_jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'pending'"
  )
    .bind(Date.now(), jobId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * "Your batch finished"
 * ──────────────────────────────────────────────────────────────────────────── */

export interface BatchNotifyResult {
  notified: boolean;
  reason?: string;
  done: number;
  failed: number;
  total: number;
}

/**
 * Tell the operator a bulk-narration batch finished — once, whichever worker
 * happened to complete the last job.
 *
 * Deliberately the SAME shape as the existing operator notification
 * (lib/update-check.ts): a Resend email to ADMIN_EMAIL, silently skipped when
 * either credential is absent, and never allowed to fail the request that
 * triggered it. It is a nice-to-have on top of the always-available in-portal
 * view, exactly as the update notice is.
 *
 * It is NOT a push fan-out. `recordPublish()` is what wakes readers' phones, and
 * a batch of narration finishing is not a publication — the words readers were
 * told about did not change. The caller still calls `recordPublish(…, announce:
 * false)` per completion so `library_state` advances and every reader re-fetches
 * the manifest; this is the operator's half of the same event.
 *
 * The `notified_at` claim is a conditional UPDATE for the same reason a job
 * claim is: several workers can finish their last job at once, and exactly one
 * of them should send the mail.
 */
export async function notifyBatchFinished(env: Env, batchId: string): Promise<BatchNotifyResult> {
  const stats = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM narration_jobs WHERE batch_id = ?`
  )
    .bind(batchId)
    .first<{ total: number; done: number; failed: number }>();
  const total = Number(stats?.total ?? 0);
  const done = Number(stats?.done ?? 0);
  const failed = Number(stats?.failed ?? 0);

  const claimed = await env.DB.prepare(
    'UPDATE narration_batches SET notified_at = ? WHERE id = ? AND notified_at IS NULL'
  )
    .bind(Date.now(), batchId)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) {
    return { notified: false, reason: 'already_notified', done, failed, total };
  }
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) {
    return { notified: false, reason: 'no_mail_configured', done, failed, total };
  }

  const subject =
    failed > 0
      ? `${env.APP_NAME}: narration finished — ${done} of ${total} chapters, ${failed} failed`
      : `${env.APP_NAME}: narration finished — ${done} chapter${done === 1 ? '' : 's'}`;
  const notified = await sendMail(
    env.RESEND_API_KEY,
    `${env.APP_NAME} <noreply@storylark-updates.local>`,
    env.ADMIN_EMAIL,
    subject,
    batchEmail(env.APP_NAME, done, failed, total)
  ).catch(() => false);
  return { notified, done, failed, total };
}

function batchEmail(appName: string, done: number, failed: number, total: number): string {
  return `<!doctype html>
<body style="font-family: Georgia, serif; background:#f4f0e6; padding:32px; color:#23262d;">
  <div style="max-width:480px; margin:0 auto; background:#fbf8f1; border:1px solid #d8d1c0; border-radius:8px; padding:32px;">
    <h1 style="font-size:20px; margin:0 0 16px;">${appName}</h1>
    <p>A narration batch has finished: <strong>${done} of ${total}</strong> chapter${total === 1 ? '' : 's'} now have audio.</p>
    ${failed > 0 ? `<p style="color:#8C4420;"><strong>${failed}</strong> failed. Open your site's <code>/admin</code> page to see which, and why — each failure keeps its own message.</p>` : '<p>Nothing failed.</p>'}
    <p style="margin:24px 0;">Readers pick the new audio up on their next manifest refresh; nothing was announced, because the words did not change.</p>
  </div>
</body>`;
}

function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}
