/**
 * The admin portal's Narration card (AB#7412 — plan §8 item 4).
 *
 * ── What this card is for ───────────────────────────────────────────────────
 * Plan §8: "a bulk narration queue with progress and a realistic time estimate,
 * not an import that appears to finish instantly and then quietly has no audio
 * for a week." Before this, a fifty-story import told an operator nothing: no
 * list of what was owed, no progress, no way to see what failed halfway. This is
 * that list.
 *
 * ── The honesty rule, in the UI ─────────────────────────────────────────────
 * No StoryLark deployment can run the narration model — a Worker cannot at all,
 * and the Node entry deliberately ships no TTS dependency. So this card never
 * shows a "Narrate now" button that would spin and lie. It shows the queue, the
 * reason the deployment cannot drain it, and the command that can, in the
 * deployment's own words (`runtime.reason` / `runtime.runCommand` from the API)
 * rather than a sentence hard-coded here that would become wrong the day an
 * in-deployment narrator ships.
 *
 * ── Why this polls, when nothing else in the portal does ────────────────────
 * Because it is the only card describing work happening somewhere else. Every
 * other panel shows state that only changes when the operator changes it, so a
 * one-shot fetch is correct for them and would be wrong here: the whole point is
 * watching a number go down. The poll stops when the queue is idle and when the
 * tab is hidden, so an open /admin tab is not a standing request generator.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { call, ApiError } from '../../lib/api';

function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return call<T>(`/admin${path}`, init);
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.detail) return err.detail;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

interface NarrationJob {
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
}

interface NarrationBatch {
  id: string;
  createdAt: number;
  createdBy: string | null;
  label: string | null;
  total: number;
  done: number;
  failed: number;
  pending: number;
  running: number;
}

interface QueueView {
  available: boolean;
  message?: string;
  runtime: {
    platform: string;
    canProcessInDeployment: boolean;
    reason: string;
    runCommand: string;
    workerAuthConfigured: boolean;
  };
  counts: Record<JobStatus, number>;
  charsRemaining: number;
  estimateSeconds: number | null;
  charsPerSecond: number | null;
  jobs: NarrationJob[];
  batches: NarrationBatch[];
}

const POLL_MS = 5000;

export function NarrationSection(): JSX.Element {
  const [view, setView] = useState<QueueView | null>(null);
  const [unavailable, setUnavailable] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [showAll, setShowAll] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await adminFetch<QueueView>('/narration?limit=100'));
      setUnavailable('');
    } catch (err) {
      // 404 = an engine from before the queue existed. Worth saying rather than
      // showing an empty box, exactly as the theme card does.
      setUnavailable(
        err instanceof ApiError && err.status === 404
          ? 'This deployment is running an engine from before the narration queue. Update it to track bulk narration from here.'
          : errorText(err, 'Could not read the narration queue.')
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while there is something to watch, and only while the tab is
  // visible. An idle queue in a background tab costs nothing.
  const busyCount = (view?.counts.pending ?? 0) + (view?.counts.running ?? 0);
  useEffect(() => {
    if (busyCount === 0 || unavailable) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
      timer.current = setTimeout(tick, POLL_MS);
    };
    timer.current = setTimeout(tick, POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [busyCount, unavailable, refresh]);

  async function act(label: string, path: string, init?: RequestInit): Promise<void> {
    setBusy(label);
    setMessage('');
    try {
      const res = await adminFetch<{ queued?: number; message?: string }>(path, { method: 'POST', ...init });
      setMessage(res.message ?? (typeof res.queued === 'number' ? `${res.queued} chapter(s) queued.` : 'Done.'));
      await refresh();
    } catch (err) {
      setMessage(errorText(err, 'That did not work.'));
    } finally {
      setBusy('');
    }
  }

  if (unavailable) {
    return (
      <section class="settings-section">
        <h2>Narration</h2>
        <p class="settings-note">{unavailable}</p>
      </section>
    );
  }
  if (!view) {
    return (
      <section class="settings-section">
        <h2>Narration</h2>
        <p class="settings-note">Loading…</p>
      </section>
    );
  }
  if (!view.available) {
    return (
      <section class="settings-section">
        <h2>Narration</h2>
        <p class="settings-note admin-notice">{view.message}</p>
      </section>
    );
  }

  const { counts } = view;
  const jobs = showAll ? view.jobs : view.jobs.filter((j) => j.status !== 'done').slice(0, 25);

  return (
    <section class="settings-section">
      <h2>Narration</h2>

      <ul class="admin-status-list">
        <li>
          <span>Waiting</span>
          <strong>{counts.pending}</strong>
        </li>
        <li>
          <span>Being narrated</span>
          <strong>{counts.running}</strong>
        </li>
        <li>
          <span>Done</span>
          <strong>{counts.done}</strong>
        </li>
        <li>
          <span>Failed</span>
          <strong>{counts.failed}</strong>
        </li>
      </ul>

      {busyCount > 0 ? (
        <p class="settings-note">
          {view.charsRemaining.toLocaleString()} characters of text still to narrate.{' '}
          {view.estimateSeconds === null
            ? 'No time estimate yet — nothing has finished on this deployment, so there is no measured speed to work from. The first completed chapter produces one.'
            : `Roughly ${formatDuration(view.estimateSeconds)} left, at the ${Math.round(view.charsPerSecond ?? 0)} characters/second this deployment has actually been managing.`}
        </p>
      ) : (
        <p class="settings-note">Nothing is waiting. Every chapter's audio matches its text.</p>
      )}

      {/* The constraint, in the deployment's own words rather than a sentence
          hard-coded in the browser bundle. */}
      <p class="settings-note admin-notice">
        {view.runtime.reason}
        <br />
        Run this where your publishing pipeline runs:
      </p>
      <p class="admin-command">
        <code>{view.runtime.runCommand}</code>
      </p>
      {!view.runtime.workerAuthConfigured && (
        <p class="settings-note admin-error">
          This deployment has no ADMIN_KEY set, so a narration worker has no way to authenticate to it. Set one in the
          deployment's configuration — it is the same key the publish pipeline already uses.
        </p>
      )}

      <div class="settings-row">
        <button class="btn" disabled={!!busy} onClick={() => void act('Queueing…', '/narration/enqueue', { body: JSON.stringify({}) })}>
          {busy || 'Queue everything that needs it'}
        </button>
        <button class="btn-ghost" disabled={!!busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {message && <p class="settings-note">{message}</p>}

      {view.batches.length > 0 && (
        <>
          <h3>Batches</h3>
          <ul class="admin-content-list">
            {view.batches.slice(0, 5).map((batch) => (
              <li class="admin-content-row" key={batch.id}>
                <div class="admin-content-row-main">
                  <span>{batch.label ?? batch.id}</span>
                  <span class="admin-content-row-meta">
                    {batch.done}/{batch.total} done
                    {batch.failed > 0 ? ` · ${batch.failed} failed` : ''}
                    {batch.createdBy ? ` · ${batch.createdBy}` : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {jobs.length > 0 && (
        <>
          <h3>Chapters</h3>
          <ul class="admin-content-list">
            {jobs.map((job) => (
              <li class="admin-content-row" key={job.id}>
                <div class="admin-content-row-main">
                  <span>
                    {job.bookId} / {job.chapterId} <StatusBadge status={job.status} />
                  </span>
                  <span class="admin-content-row-meta">
                    {job.status === 'running' && job.worker ? `on ${job.worker} · ` : ''}
                    {job.attempts > 1 ? `attempt ${job.attempts} · ` : ''}
                    {job.charLength.toLocaleString()} characters
                    {job.status === 'done' && job.durationMs > 0 ? ` · ${formatDuration(job.durationMs / 1000)} of audio` : ''}
                  </span>
                  {job.error && <span class="admin-content-row-meta admin-error">{job.error}</span>}
                </div>
                {job.status === 'failed' && (
                  <button
                    class="admin-row-action"
                    disabled={!!busy}
                    onClick={() => void act('Retrying…', `/narration/jobs/${encodeURIComponent(job.id)}/retry`)}
                  >
                    Retry
                  </button>
                )}
                {job.status === 'pending' && (
                  <button
                    class="admin-row-action"
                    disabled={!!busy}
                    onClick={() => {
                      setBusy('Cancelling…');
                      setMessage('');
                      adminFetch(`/narration/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' })
                        .then(() => refresh())
                        .catch((err) => setMessage(errorText(err, 'Could not cancel that job.')))
                        .finally(() => setBusy(''));
                    }}
                  >
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {view.jobs.length > jobs.length && (
        <button class="btn-ghost" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show only outstanding work' : `Show all ${view.jobs.length} recent jobs`}
        </button>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: JobStatus }): JSX.Element | null {
  if (status === 'done') return null;
  const warn = status === 'failed';
  return <span class={warn ? 'admin-badge admin-badge-warn' : 'admin-badge'}>{status}</span>;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
