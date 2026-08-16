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
      // The chapter JSON is also the manifest of its own art (AB#7421): image
      // blocks name the files the page needs, and they are only knowable once
      // the text has been fetched. A downloaded story missing its illustrations
      // is the bug this closes.
      if (url === contentUrl(chapter.content)) {
        bytes += await cacheChapterImages(cache, buf);
      }
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
 * Cache every image a chapter references, so an offline read still has its art.
 *
 * Best-effort per image, deliberately: art can live on a marketing origin that
 * sends no CORS headers, and a cross-origin fetch there comes back opaque —
 * which `cache.put` refuses outright. Letting one such image fail the whole
 * download would mean a story with one decorative image could never be taken
 * offline at all. A missed image degrades to the alt text the renderer already
 * shows as its read-along fallback; a missed chapter is a broken download.
 *
 * Returns the bytes actually cached, so the size shown in Settings reflects
 * what is really stored rather than only the text and audio.
 */
async function cacheChapterImages(cache: Cache, chapterJson: ArrayBuffer): Promise<number> {
  let srcs: string[];
  try {
    const doc = JSON.parse(new TextDecoder().decode(chapterJson)) as { blocks?: { type?: string; src?: string }[] };
    srcs = [...new Set((doc.blocks ?? []).filter((b) => b.type === 'image' && b.src).map((b) => b.src as string))];
  } catch {
    return 0;
  }
  let bytes = 0;
  for (const src of srcs) {
    try {
      const res = await fetch(src, { cache: 'no-cache' });
      if (!res.ok || res.type === 'opaque') continue;
      const buf = await res.arrayBuffer();
      await cache.put(src, new Response(buf, { headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'image/*' } }));
      bytes += buf.byteLength;
    } catch {
      // Unreachable or cross-origin without CORS — the chapter is still offline,
      // this one image just isn't.
    }
  }
  return bytes;
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
  // Art is shared across a book's chapters and isn't named after any one of
  // them, so it can only be dropped once nothing from this book is downloaded
  // any more. Leaving it would quietly grow the cache a reader thinks they
  // emptied.
  const remaining = await idb.getAll<DownloadRecord>('downloads');
  if (!remaining.some((r) => r.bookId === bookId)) {
    const images = contentUrl(`books/${bookId}/images/`);
    for (const req of await cache.keys()) {
      if (req.url.startsWith(images)) await cache.delete(req);
    }
  }
  const next = new Map(downloadStates.value);
  next.delete(key(bookId, chapterId));
  downloadStates.value = next;
}

/** All completed download records (name/size come from here for the Settings status list). */
export async function getDownloadRecords(): Promise<DownloadRecord[]> {
  return idb.getAll<DownloadRecord>('downloads');
}
