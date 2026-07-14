import type { ChapterEntry, DownloadRecord } from './types';
import { chapterTrack } from './player';
import { contentUrl } from '../brand';
import { idb } from './db';
import { signal } from '@preact/signals';

export const DOWNLOAD_CACHE = 'sr-downloads';

export const downloadStates = signal<Map<string, 'downloading' | 'done'>>(new Map());

function key(bookId: string, chapterId: string): string {
  return `${bookId}/${chapterId}`;
}

export async function initDownloadStates(): Promise<void> {
  const records = await idb.getAll<DownloadRecord>('downloads');
  const next = new Map<string, 'downloading' | 'done'>();
  // Re-verify against the actual cache — iOS may have evicted entries.
  const cache = await caches.open(DOWNLOAD_CACHE);
  for (const r of records) {
    const contentRes = await cache.match(contentUrl(`books/${r.bookId}/chapters/${r.chapterId}.${r.contentHash}.json`));
    if (contentRes) next.set(key(r.bookId, r.chapterId), 'done');
    else await idb.delete('downloads', key(r.bookId, r.chapterId));
  }
  downloadStates.value = next;
}

export async function downloadChapter(bookId: string, chapter: ChapterEntry): Promise<void> {
  const k = key(bookId, chapter.id);
  downloadStates.value = new Map(downloadStates.value).set(k, 'downloading');
  try {
    const cache = await caches.open(DOWNLOAD_CACHE);
    const urls = [contentUrl(chapter.content)];
    if (chapter.hasAudio && chapter.audio) urls.push(contentUrl(chapter.audio));
    if (chapter.timings) urls.push(contentUrl(chapter.timings));
    // Also keep the chosen narrator's track offline when it differs from the default.
    const track = chapterTrack(chapter);
    if (chapter.hasAudio && track.audio && track.audio !== chapter.audio) {
      urls.push(contentUrl(track.audio));
      if (track.timings) urls.push(contentUrl(track.timings));
    }

    let bytes = 0;
    for (const url of urls) {
      // Full-body fetch (no Range) so the SW can slice cached audio for seeks.
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`download failed: ${url} ${res.status}`);
      const buf = await res.arrayBuffer();
      bytes += buf.byteLength;
      await cache.put(url, new Response(buf, { headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/octet-stream' } }));
    }

    const record: DownloadRecord = {
      bookId,
      chapterId: chapter.id,
      contentHash: chapter.contentHash,
      bytes,
      hasAudio: chapter.hasAudio,
      completedAt: Date.now(),
    };
    await idb.put('downloads', record, k);
    downloadStates.value = new Map(downloadStates.value).set(k, 'done');
  } catch (err) {
    const next = new Map(downloadStates.value);
    next.delete(k);
    downloadStates.value = next;
    throw err;
  }
}

/**
 * Remove a chapter's downloaded artifacts. Works from ids alone (no manifest
 * entry needed) by matching cached URLs, so it also clears entries whose
 * content hash has since changed in a republish.
 */
export async function removeDownload(bookId: string, chapterId: string): Promise<void> {
  const cache = await caches.open(DOWNLOAD_CACHE);
  const prefix = contentUrl(`books/${bookId}/`);
  for (const req of await cache.keys()) {
    if (req.url.startsWith(prefix) && req.url.includes(`/${chapterId}.`)) await cache.delete(req);
  }
  await idb.delete('downloads', key(bookId, chapterId));
  const next = new Map(downloadStates.value);
  next.delete(key(bookId, chapterId));
  downloadStates.value = next;
}

/** All completed download records (name/size come from here for the Settings status list). */
export async function getDownloadRecords(): Promise<DownloadRecord[]> {
  return idb.getAll<DownloadRecord>('downloads');
}
