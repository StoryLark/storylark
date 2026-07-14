import type { JSX } from 'preact';
import { manifest, progressMap, progressKey, modeFor } from '../lib/state';
import { downloadStates, downloadChapter } from '../lib/downloads';
import { fmtDuration, startPlayback } from '../lib/player';
import { openItem } from '../lib/open-item';
import { navigate } from '../router';
import { contentUrl, NOUNS, countUnits } from '../brand';
import { bookProgress } from './Library';
import { DownloadButton } from '../components/DownloadButton';
import type { BookEntry, ChapterEntry } from '../lib/types';

export function Book({ bookId }: { bookId: string }): JSX.Element {
  const book = manifest.value?.books.find((b) => b.id === bookId);
  if (!book) {
    return (
      <div class="screen">
        <p class="empty-state">{NOUNS.Collection ?? NOUNS.Unit} not found.</p>
      </div>
    );
  }

  const pct = bookProgress(book);
  // Resume target: the most recently touched unfinished chapter, else the first unfinished one.
  let resume: ChapterEntry | undefined;
  let resumeAt = -1;
  for (const ch of book.chapters) {
    const p = progressMap.value.get(progressKey(book.id, ch.id));
    if (p && p.percent > 0 && p.percent < 0.995 && p.updatedAt > resumeAt) {
      resume = ch;
      resumeAt = p.updatedAt;
    }
  }
  if (!resume) resume = book.chapters.find((ch) => (progressMap.value.get(progressKey(book.id, ch.id))?.percent ?? 0) < 0.995);
  const resumeCh = resume;
  const started = pct > 0;

  return (
    <div class="screen book-screen">
      <header class="reader-header">
        <button class="icon-btn" onClick={() => navigate('/library')} aria-label="Back to library">
          ←
        </button>
        <div class="reader-heading">
          {book.series && <span class="reader-label">{book.series}</span>}
          <span class="reader-title">{book.title}</span>
        </div>
        <span />
      </header>

      <div class="book-hero">
        {book.cover ? (
          <img class="book-hero-cover" src={contentUrl(book.cover)} alt="" />
        ) : (
          <span class="book-hero-cover new-cover-fallback" aria-hidden="true">
            {book.title.slice(0, 1)}
          </span>
        )}
        <h1 class="book-hero-title">{book.title}</h1>
        <p class="book-author">{book.author}</p>
        {book.description && <p class="book-description">{book.description}</p>}
        {started && (
          <div class="book-hero-progress">
            <span class="chapter-progress">
              <span class="chapter-progress-fill" style={{ width: `${Math.min(100, Math.round(pct * 100))}%` }} />
            </span>
            <span class="chapter-meta">{Math.round(pct * 100)}% complete</span>
          </div>
        )}
        {resumeCh && (
          <button class="btn btn-resume" onClick={() => openItem(book.id, resumeCh.id)}>
            {started ? `Resume: ${resumeCh.label ?? resumeCh.title}` : 'Start'}
          </button>
        )}
        <DownloadBookButton book={book} />
      </div>

      <ol class="chapter-list book-chapter-list">
        {book.chapters.map((ch) => (
          <BookChapterRow key={ch.id} bookId={book.id} chapter={ch} />
        ))}
      </ol>
    </div>
  );
}

/**
 * Whole-book download (Audible-style): every chapter's text + audio into the
 * downloads cache, with aggregate per-chapter progress. Brand nouns come from
 * NOUNS — in a series library the units are CHAPTERS of a COLLECTION (never
 * "book 1 of 2"); in a flat library (single-unit books, if ever routed here)
 * the unit is a standalone STORY.
 */
function DownloadBookButton({ book }: { book: BookEntry }): JSX.Element | null {
  if (book.chapters.length === 0) return null;
  const states = downloadStates.value;
  const done = book.chapters.filter((ch) => states.get(`${book.id}/${ch.id}`) === 'done').length;
  const total = book.chapters.length;
  const downloading = book.chapters.some((ch) => states.get(`${book.id}/${ch.id}`) === 'downloading');
  const whole = NOUNS.collection ?? NOUNS.unit; // collection noun (series) / unit noun (flat)

  if (done === total) {
    return (
      <p class="book-dl-status" role="status">
        ✓ {NOUNS.Collection ?? NOUNS.Unit} downloaded for offline: {total > 1 ? `all ${countUnits(total)}, ` : ''}text and audio
      </p>
    );
  }
  if (downloading) {
    return (
      <button class="btn btn-download" disabled aria-live="polite">
        Downloading {NOUNS.unit} {Math.min(done + 1, total)} of {total}…
      </button>
    );
  }
  const downloadAll = async (): Promise<void> => {
    for (const ch of book.chapters) {
      if (downloadStates.value.get(`${book.id}/${ch.id}`) === 'done') continue;
      await downloadChapter(book.id, ch).catch(() => undefined);
    }
  };
  return (
    <button
      class="btn btn-download"
      onClick={() => void downloadAll()}
      aria-label={`Download the whole ${whole} for offline: text and audio`}
    >
      ↓ Download {whole}
      {done > 0 ? `, ${countUnits(total - done)} left` : total > 1 ? `, ${countUnits(total)}` : ''}
    </button>
  );
}

function BookChapterRow({ bookId, chapter }: { bookId: string; chapter: ChapterEntry }): JSX.Element {
  const p = progressMap.value.get(progressKey(bookId, chapter.id));
  const dl = downloadStates.value.get(`${bookId}/${chapter.id}`);
  const mode = modeFor(bookId, chapter.id);
  return (
    <li class="book-chapter-row">
      <button class="book-chapter-main" onClick={() => openItem(bookId, chapter.id)}>
        <span class="chapter-main">
          <span class="chapter-label">{chapter.label ?? chapter.title}</span>
          {chapter.label && <span class="chapter-title">{chapter.title}</span>}
        </span>
        <span class="chapter-meta">
          {chapter.hasAudio && chapter.audioDurationMs > 0 && `♪ ${fmtDuration(chapter.audioDurationMs)} · `}
          {chapter.readingTime ?? `${chapter.wordCount} words`}
          {dl === 'done' && ' · ↓ offline'}
          {` · opens in ${mode === 'both' ? 'read + listen' : mode}`}
        </span>
        {p && p.percent > 0 && (
          <span class="chapter-progress">
            <span class="chapter-progress-fill" style={{ width: `${Math.min(100, Math.round(p.percent * 100))}%` }} />
          </span>
        )}
      </button>
      <span class="book-chapter-actions">
        <DownloadButton bookId={bookId} chapter={chapter} name={chapter.label ?? chapter.title} />
        <button
          class="row-play"
          aria-label={`Listen to ${chapter.title}`}
          onClick={() => {
            void startPlayback(bookId, chapter.id);
            navigate('/now-playing');
          }}
        >
          ▶
        </button>
        <button class="row-read" aria-label={`Read ${chapter.title}`} onClick={() => openItem(bookId, chapter.id, 'read')}>
          ☰
        </button>
      </span>
    </li>
  );
}
