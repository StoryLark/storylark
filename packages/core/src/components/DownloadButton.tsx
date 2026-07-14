import type { JSX } from 'preact';
import type { ChapterEntry } from '../lib/types';
import { downloadStates, downloadChapter, removeDownload } from '../lib/downloads';

/**
 * Per-item download control for Library rows: download → in-progress →
 * downloaded (tap again to remove). Storage lives in the downloads cache;
 * Settings shows the status-only list of everything downloaded.
 */
export function DownloadButton({ bookId, chapter, name }: { bookId: string; chapter: ChapterEntry; name?: string }): JSX.Element {
  const state = downloadStates.value.get(`${bookId}/${chapter.id}`);
  const label = name ?? chapter.title;

  if (state === 'downloading') {
    return (
      <button class="row-dl" disabled aria-label={`Downloading ${label}`} title="Downloading…">
        …
      </button>
    );
  }
  if (state === 'done') {
    return (
      <button
        class="row-dl row-dl-done"
        aria-label={`Remove download of ${label}`}
        title="Downloaded: tap to remove"
        onClick={() => void removeDownload(bookId, chapter.id)}
      >
        ✓
      </button>
    );
  }
  return (
    <button
      class="row-dl"
      aria-label={`Download ${label} for offline`}
      title="Download for offline"
      onClick={() => void downloadChapter(bookId, chapter).catch(() => undefined)}
    >
      ↓
    </button>
  );
}
