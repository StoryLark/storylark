import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { manifest, progressMap, progressKey, hasNewContent, markLibrarySeen } from '../lib/state';
import { downloadStates } from '../lib/downloads';
import { DownloadButton } from '../components/DownloadButton';
import { fmtDuration, isStoryBrand, startPlayback } from '../lib/player';
import { openItem } from '../lib/open-item';
import { navigate } from '../router';
import { BRAND, NOUNS, contentUrl, countUnits } from '../brand';
import type { BookEntry, ChapterEntry } from '../lib/types';

export function Library(): JSX.Element {
  const m = manifest.value;
  return (
    <div class="screen library">
      <header class="screen-header">
        <h1 class="screen-title">Library</h1>
        <p class="app-tagline">{BRAND.tagline}</p>
      </header>

      {hasNewContent.value && (
        <div class="new-banner" onClick={() => void markLibrarySeen()}>
          New content in the library
        </div>
      )}

      {!m && <p class="empty-state">Loading the library…</p>}
      {m && m.books.length === 0 && <p class="empty-state">No {NOUNS.unitPlural} published yet. Check back soon.</p>}
      {m && m.books.length > 0 && (isStoryBrand() ? <StoryLibrary books={m.books} /> : <SeriesLibrary books={m.books} />)}
    </div>
  );
}

// ---- gunner: flat, searchable, sortable list of stories ----
//
// Four views onto the same stories, matching the series' three-axis metadata:
//   order      — the numbered reading order the author intends (manifest order)
//   chrono     — in-world timeline, by each story's `timeframe` ("YYYY-MM")
//   released   — real-world release date, newest first (`publishDate`)
//   collection — grouped by era/collection, each section in in-world order
type SortKey = 'order' | 'chrono' | 'released' | 'collection';

function StoryLibrary({ books }: { books: BookEntry[] }): JSX.Element {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('order');

  const q = query.trim().toLowerCase();
  let list = books.filter((b) => b.chapters.length > 0);
  if (q) {
    list = list.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        (b.group ?? '').toLowerCase().includes(q) ||
        (b.description ?? '').toLowerCase().includes(q)
    );
  }

  return (
    <>
      <div class="library-controls">
        <input
          class="library-search"
          type="search"
          placeholder="Search stories…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          aria-label="Search stories by title or era"
        />
        <select class="library-sort" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as SortKey)} aria-label="Sort stories">
          <option value="order">Story order</option>
          <option value="chrono">Chronological</option>
          <option value="released">Recently released</option>
          <option value="collection">By collection</option>
        </select>
      </div>

      {list.length === 0 && <p class="empty-state">No stories match “{query}”.</p>}
      {sort === 'collection' ? (
        <StoryCollections books={list} />
      ) : (
        <ul class="story-list">
          {sortStories(list, sort).map((book) => (
            <li key={book.id}>
              <StoryRow book={book} chapter={book.chapters[0]} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Flat sort for the non-grouped views. 'order' preserves the manifest's reading order. */
function sortStories(books: BookEntry[], sort: SortKey): BookEntry[] {
  const list = [...books];
  if (sort === 'chrono') {
    list.sort((a, b) => cmpAsc(a.timeframe, b.timeframe) || (a.bookOrder ?? 999) - (b.bookOrder ?? 999));
  } else if (sort === 'released') {
    list.sort((a, b) => cmpAsc(releaseDate(b), releaseDate(a))); // newest first
  }
  return list;
}

/** gunner: stories grouped under their era/collection; sections and rows in in-world order. */
function StoryCollections({ books }: { books: BookEntry[] }): JSX.Element {
  const groups = new Map<string, BookEntry[]>();
  for (const b of books) {
    const key = b.group || 'Other Stories';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => cmpAsc(a.timeframe, b.timeframe) || (a.bookOrder ?? 999) - (b.bookOrder ?? 999));
  }
  const sections = [...groups.entries()].sort((a, b) => cmpAsc(earliest(a[1]), earliest(b[1])));

  return (
    <>
      {sections.map(([name, list]) => (
        <section key={name} class="series-section">
          <h2 class="group-title">{name}</h2>
          <ul class="story-list">
            {list.map((book) => (
              <li key={book.id}>
                <StoryRow book={book} chapter={book.chapters[0]} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** Ascending string compare that sorts missing/empty values last. */
function cmpAsc(a?: string, b?: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

function releaseDate(b: BookEntry): string | undefined {
  return b.publishDate ?? b.chapters[0]?.publishedAt;
}

/** Earliest in-world timeframe within a collection — orders the sections. */
function earliest(list: BookEntry[]): string | undefined {
  let min: string | undefined;
  for (const b of list) if (b.timeframe && (!min || b.timeframe < min)) min = b.timeframe;
  return min;
}

function StoryRow({ book, chapter }: { book: BookEntry; chapter: ChapterEntry }): JSX.Element {
  const p = progressMap.value.get(progressKey(book.id, chapter.id));
  const dl = downloadStates.value.get(`${book.id}/${chapter.id}`);
  return (
    <div class="story-row">
      <button class="story-main" onClick={() => openItem(book.id, chapter.id)}>
        {book.cover ? (
          <img class="story-cover" src={contentUrl(book.cover)} alt="" loading="lazy" />
        ) : (
          <span class="story-cover new-cover-fallback" aria-hidden="true">
            {book.title.slice(0, 1)}
          </span>
        )}
        <span class="story-body">
          <span class="story-title">{book.title}</span>
          {book.group && <span class="story-era">{book.group}</span>}
          <span class="chapter-meta">
            {chapter.hasAudio && chapter.audioDurationMs > 0 ? `♪ ${fmtDuration(chapter.audioDurationMs)}` : chapter.readingTime ?? `${chapter.wordCount} words`}
            {dl === 'done' && ' · ↓ offline'}
          </span>
          {p && p.percent > 0 && (
            <span class="chapter-progress">
              <span class="chapter-progress-fill" style={{ width: `${Math.min(100, Math.round(p.percent * 100))}%` }} />
            </span>
          )}
        </span>
      </button>
      <DownloadButton bookId={book.id} chapter={chapter} name={book.title} />
      <button
        class="row-play"
        aria-label={`Listen to ${book.title}`}
        onClick={() => {
          void startPlayback(book.id, chapter.id);
          navigate('/now-playing');
        }}
      >
        ▶
      </button>
    </div>
  );
}

// ---- holdfast: Series → Book → chapters (Audible-like) ----

function SeriesLibrary({ books }: { books: BookEntry[] }): JSX.Element {
  const series = new Map<string, BookEntry[]>();
  for (const b of books) {
    // Older manifests carry no series metadata — fall back to one shelf.
    const s = b.series ?? b.group ?? BRAND.name;
    if (!series.has(s)) series.set(s, []);
    series.get(s)!.push(b);
  }
  for (const list of series.values()) list.sort((a, b) => (a.bookOrder ?? 999) - (b.bookOrder ?? 999));
  const entries = [...series.entries()].sort(
    (a, b) => Math.min(...a[1].map((x) => x.seriesOrder ?? 999)) - Math.min(...b[1].map((x) => x.seriesOrder ?? 999))
  );
  return (
    <>
      {entries.map(([name, list]) => (
        <section key={name} class="series-section">
          <h2 class="group-title">{name}</h2>
          {list.map((book) => (
            <SeriesBookCard key={book.id} book={book} />
          ))}
        </section>
      ))}
    </>
  );
}

export function bookProgress(book: BookEntry): number {
  let done = 0;
  let total = 0;
  for (const ch of book.chapters) {
    const w = ch.wordCount || 1;
    total += w;
    const p = progressMap.value.get(progressKey(book.id, ch.id));
    done += Math.min(1, p?.percent ?? 0) * w;
  }
  return total > 0 ? done / total : 0;
}

function SeriesBookCard({ book }: { book: BookEntry }): JSX.Element {
  const pct = bookProgress(book);
  return (
    <button class="series-book-card" onClick={() => navigate(`/library/${encodeURIComponent(book.id)}`)}>
      {book.cover ? (
        <img class="series-book-cover" src={contentUrl(book.cover)} alt="" loading="lazy" />
      ) : (
        <span class="series-book-cover new-cover-fallback" aria-hidden="true">
          {book.title.slice(0, 1)}
        </span>
      )}
      <span class="series-book-body">
        <span class="book-title">{book.title}</span>
        <span class="book-author">{book.author}</span>
        <span class="chapter-meta">
          {countUnits(book.chapters.length)}
          {pct > 0 && ` · ${Math.round(pct * 100)}%`}
        </span>
        {pct > 0 && (
          <span class="chapter-progress">
            <span class="chapter-progress-fill" style={{ width: `${Math.min(100, Math.round(pct * 100))}%` }} />
          </span>
        )}
      </span>
      <span class="series-book-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
