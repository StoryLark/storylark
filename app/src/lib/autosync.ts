// Auto-sync + auto-download.
//
// Auto-sync (Settings): when the app opens or regains connectivity, check
// /api/library/version and re-fetch the manifest; fetch the text of any new
// or changed chapters so they render instantly (the SW's runtime cache keeps
// the fetched JSON).
//
// Auto-download (Settings): gunner — download stories added after the toggle
// was turned on (incl. audio); holdfast — keep the entire book downloaded
// (every chapter incl. audio).

import { api } from './api';
import { idb } from './db';
import { contentUrl, BRAND } from '../brand';
import { manifest, settings, loadManifest } from './state';
import { downloadStates, downloadChapter } from './downloads';

let syncing = false;

export function initAutoSync(): void {
  const run = (): void => {
    if (settings.value.autoSync && navigator.onLine) void syncNow();
  };
  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
  run();
}

export async function syncNow(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    // Cheap freshness probe first; a failure just means we skip to the manifest.
    let needsManifest = true;
    try {
      const { version } = await api.libraryVersion();
      needsManifest = version > (manifest.value?.libraryVersion ?? 0) || !manifest.value;
    } catch {
      // version endpoint unreachable — fall through and refresh the manifest anyway
    }
    if (needsManifest) await loadManifest();

    const m = manifest.value;
    if (!m) return;

    const synced = (await idb.get<Record<string, string>>('kv', 'syncedHashes')) ?? {};
    let dirty = false;
    for (const book of m.books) {
      for (const ch of book.chapters) {
        const key = `${book.id}/${ch.id}`;
        if (synced[key] !== ch.contentHash) {
          try {
            const res = await fetch(contentUrl(ch.content));
            if (res.ok) {
              synced[key] = ch.contentHash;
              dirty = true;
            }
          } catch {
            // offline mid-sync — retry next time
          }
        }
      }
    }
    if (dirty) await idb.put('kv', synced, 'syncedHashes');

    if (settings.value.autoDownload) await autoDownloadPass();
  } finally {
    syncing = false;
  }
}

/** Record the current library as "already there" so gunner only auto-downloads future stories. */
export async function setAutoDownloadBaseline(): Promise<void> {
  const m = manifest.value;
  const keys = m ? m.books.flatMap((b) => b.chapters.map((c) => `${b.id}/${c.id}`)) : [];
  await idb.put('kv', keys, 'autoDownloadBaseline');
}

async function autoDownloadPass(): Promise<void> {
  const m = manifest.value;
  if (!m) return;
  const baseline = BRAND.id === 'gunner' ? ((await idb.get<string[]>('kv', 'autoDownloadBaseline')) ?? []) : [];
  for (const book of m.books) {
    for (const ch of book.chapters) {
      const key = `${book.id}/${ch.id}`;
      if (downloadStates.value.get(key)) continue;
      // gunner: only stories that appeared after the toggle was enabled.
      if (BRAND.id === 'gunner' && baseline.includes(key)) continue;
      await downloadChapter(book.id, ch).catch(() => undefined);
    }
  }
}
