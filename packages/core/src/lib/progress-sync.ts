import type { Progress } from './types';
import { idb } from './db';
import { api } from './api';
import { progressMap, progressKey, user } from './state';

// Offline-first progress: every save lands in IndexedDB immediately and is
// queued in the outbox; the outbox replays FIFO whenever we're online.
// The server applies last-writer-wins on updatedAt, so replays are safe.

let flushing = false;

export async function saveProgress(p: Progress): Promise<void> {
  const key = progressKey(p.bookId, p.chapterId);
  const current = progressMap.value.get(key);
  if (current && current.updatedAt >= p.updatedAt) return;
  const next = new Map(progressMap.value);
  next.set(key, p);
  progressMap.value = next;
  await idb.put('progress', p, key);
  if (user.value) {
    await idb.put('outbox', { kind: 'progress', payload: p });
    void flushOutbox();
  }
}

export async function flushOutbox(): Promise<void> {
  if (flushing || !navigator.onLine || !user.value) return;
  flushing = true;
  try {
    const keys = await idb.getAllKeys('outbox');
    for (const key of keys) {
      const item = await idb.get<{ kind: string; payload: Progress }>('outbox', key);
      if (!item) continue;
      if (item.kind === 'progress') {
        const p = item.payload;
        await api.putProgress(p.bookId, p.chapterId, {
          mode: p.mode,
          charOffset: p.charOffset,
          audioMs: p.audioMs,
          percent: p.percent,
          updatedAt: p.updatedAt,
        });
      }
      await idb.delete('outbox', key);
    }
  } catch {
    // Network or auth hiccup — leave the rest queued for the next flush.
  } finally {
    flushing = false;
  }
}

/**
 * Enqueue EVERY local progress record into the outbox and flush. Progress made
 * while signed out is written locally but never queued (saveProgress gates the
 * outbox on user.value) — this uploads that backlog once the user signs in.
 * Server-side last-writer-wins on updatedAt makes re-uploads safe.
 */
export async function pushAllLocalProgress(): Promise<void> {
  if (!user.value) return;
  const local = await idb.getAll<Progress>('progress');
  for (const p of local) await idb.put('outbox', { kind: 'progress', payload: p });
  await flushOutbox();
}

/**
 * Two-way reconcile: push local progress up, then pull server progress down
 * (both sides converge under last-writer-wins). The full local push is done
 * once per signed-in user (marker in kv), cleared on sign-out — after that,
 * saveProgress enqueues new records incrementally.
 */
export async function reconcileProgress(): Promise<void> {
  const u = user.value;
  if (u) {
    const marker = await idb.get<string>('kv', 'fullPushUser');
    if (marker !== u.id) {
      await pushAllLocalProgress();
      await idb.put('kv', u.id, 'fullPushUser');
    } else {
      await flushOutbox();
    }
  }
  await pullProgress();
}

/** Forget the full-push marker (call on sign-out) so the next sign-in re-reconciles. */
export async function resetProgressPushMarker(): Promise<void> {
  await idb.delete('kv', 'fullPushUser');
}

/** Pull server progress and merge newest-wins into local state. */
export async function pullProgress(): Promise<void> {
  if (!user.value) return;
  try {
    const { progress } = await api.getProgress();
    const next = new Map(progressMap.value);
    for (const row of progress) {
      const p: Progress = {
        bookId: row.book_id,
        chapterId: row.chapter_id,
        mode: row.mode,
        charOffset: row.char_offset,
        audioMs: row.audio_ms,
        percent: row.percent,
        updatedAt: row.updated_at,
      };
      const key = progressKey(p.bookId, p.chapterId);
      const local = next.get(key);
      if (!local || local.updatedAt < p.updatedAt) {
        next.set(key, p);
        await idb.put('progress', p, key);
      }
    }
    progressMap.value = next;
  } catch {
    // offline or signed out — local state stands
  }
}

export function startSyncLoop(): void {
  window.addEventListener('online', () => void flushOutbox());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void flushOutbox();
      void pullProgress();
    }
  });
  // Boot: push any signed-out backlog up first, then pull the server's view.
  void reconcileProgress();
}
