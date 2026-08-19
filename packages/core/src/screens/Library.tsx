import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { manifest, progressMap, progressKey, hasNewContent, markLibrarySeen, settings } from '../lib/state';
import { downloadStates } from '../lib/downloads';
import { DownloadButton } from '../components/DownloadButton';
import { fmtDuration, isStoryBrand, startPlayback } from '../lib/player';
import { openItem } from '../lib/open-item';
import { navigate } from '../router';
import { BRAND, contentUrl } from '../brand';
import { NOUNS, PRESENTATION, countUnits, fillCopy } from '../presentation';
import type { BookEntry, ChapterEntry, LibraryGroup, LibrarySort } from '../lib/types';
import { librarySortLabel, resolvePersonalLibrarySort } from '../lib/library-order';

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

      {!m && <p class="empty-state">{fillCopy(PRESENTATION.emptyState.home)}</p>}
      {m && m.books.length === 0 && <p class="empty-state">{fillCopy(PRESENTATION.emptyState.library)}</p>}
      {m && m.books.length > 0 && (isStoryBrand() ? <StoryLibrary books={m.books} /> : <SeriesLibrary books={m.books} />)}
    </div>
  );
}

// ---- Arrangement — presentation `library.*` (AB#7416 — plan §0b) ------------
//
// The shelf used to hold one hardcoded `<select>` with four entries, three of
// which were sorts and one of which ("By collection") was secretly a GROUPING
// that switched the whole rendering path. Which of the four you got, whether
// there was a search box at all, and how the sections were built were all
// decided by `layout`.
//
// All of it is presentation now:
//
//   library.defaultSort   which order the shelf opens in
//   library.sortOptions   which orders the picker offers (empty = no picker)
//   library.groupBy       which grouping it opens in
//   library.groupOptions  which groupings the picker offers alongside the sorts
//   library.view          list of rows, or a cover grid
//   library.showSearch    whether there is a search box
//
// The defaults reproduce the old behaviour exactly, per layout — see
// DEFAULT_PRESENTATION and layoutDefaults in ../presentation.ts. `title` and
// `author` sorts are implemented but not offered by default, because the
// picker has never had them and adding entries to everyone's shelf is not what
// a default is for.

/** The picker's value space: a sort, or a grouping. One control, as before. */
type Arrangement = { kind: 'sort'; key: LibrarySort } | { kind: 'group'; key: Exclude<LibraryGroup, 'none'> };

function arrangementValue(a: Arrangement): string {
  return `${a.kind}:${a.key}`;
}

function parseArrangement(value: string): Arrangement {
  const [kind, key] = value.split(':');
  return kind === 'group'
    ? { kind: 'group', key: key as Exclude<LibraryGroup, 'none'> }
    : { kind: 'sort', key: key as LibrarySort };
}

const GROUP_LABELS: Record<Exclude<LibraryGroup, 'none'>, () => string> = {
  collection: () => `By ${NOUNS.collection ?? 'collection'}`,
  group: () => 'By collection',
  timeframe: () => 'By timeframe',
};

/** The arrangement this deployment opens in. */
function initialArrangement(): Arrangement {
  const { groupBy } = PRESENTATION.library;
  const preferredSort = resolvePersonalLibrarySort(PRESENTATION.library, settings.value.librarySort);
  return groupBy === 'none' ? { kind: 'sort', key: preferredSort } : { kind: 'group', key: groupBy };
}

/**
 * The app renders before IndexedDB/account preferences finish loading. Keep
 * the local picker state in sync when that saved default arrives, while still
 * allowing temporary picker changes for the rest of this Library visit.
 */
function useLibraryArrangement(): [Arrangement, (arrangement: Arrangement) => void] {
  const preferred = initialArrangement();
  const preferredValue = arrangementValue(preferred);
  const [arrangement, setArrangement] = useState<Arrangement>(preferred);
  useEffect(() => setArrangement(parseArrangement(preferredValue)), [preferredValue]);
  return [arrangement, setArrangement];
}

/** One section of the shelf. `name` null = the ungrouped whole library. */
interface Section {
  name: string | null;
  books: BookEntry[];
}

/**
 * Divide the library into sections.
 *
 * Shared by both layouts on purpose. The two used to be separate functions with
 * separate grouping rules (StoryCollections grouped on `group` with an "Other
 * Stories" bucket; SeriesLibrary grouped on `series ?? group ?? BRAND.name`),
 * which is why `groupBy` has both a `collection` and a `group` value — they are
 * those two rules, now nameable and selectable independently of the layout.
 */
function sectionsOf(books: BookEntry[], by: LibraryGroup, within: LibrarySort): Section[] {
  if (by === 'none') return [{ name: null, books: sortBooks(books, within) }];

  const buckets = new Map<string, BookEntry[]>();
  for (const b of books) {
    const key =
      by === 'collection'
        ? (b.series ?? b.group ?? BRAND.name)
        : by === 'timeframe'
          ? (b.timeframe ?? `Undated ${NOUNS.unitPlural}`)
          : b.group || `Other ${NOUNS.UnitPlural}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(b);
  }

  const sections = [...buckets.entries()].map(([name, list]) => ({ name, books: sortBooks(list, within) }));
  // Section order: by the collection's own place in the series (`collection`,
  // matching the old SeriesLibrary) or by its earliest in-world date (`group` /
  // `timeframe`, matching the old StoryCollections). Both are the rules the two
  // paths already used; neither is new.
  if (by === 'collection') {
    sections.sort(
      (a, b) =>
        Math.min(...a.books.map((x) => x.seriesOrder ?? 999)) - Math.min(...b.books.map((x) => x.seriesOrder ?? 999))
    );
  } else {
    sections.sort((a, b) => cmpAsc(earliest(a.books), earliest(b.books)));
  }
  return sections;
}

/**
 * Order within a section.
 *
 * 'order' preserves the manifest's reading order, which is the author's
 * intent and therefore the only sort that is not a comparison. Inside a
 * GROUPED shelf the old code always used in-world order regardless of the sort
 * picker, and sortBooks is called with that same key from renderSections below,
 * so grouped output is unchanged.
 */
function sortBooks(books: BookEntry[], sort: LibrarySort): BookEntry[] {
  const list = [...books];
  switch (sort) {
    case 'timeframe':
      list.sort((a, b) => cmpAsc(a.timeframe, b.timeframe) || (a.bookOrder ?? 999) - (b.bookOrder ?? 999));
      break;
    case 'recent':
      list.sort((a, b) => cmpAsc(releaseDate(b), releaseDate(a))); // newest first
      break;
    case 'title':
      list.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'author':
      list.sort((a, b) => cmpAsc(a.author, b.author) || a.title.localeCompare(b.title));
      break;
    case 'order':
    default:
      break; // manifest order
  }
  return list;
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

/** Earliest in-world timeframe within a section — orders the sections. */
function earliest(list: BookEntry[]): string | undefined {
  let min: string | undefined;
  for (const b of list) if (b.timeframe && (!min || b.timeframe < min)) min = b.timeframe;
  return min;
}

/** Search box + arrangement picker, each present only if this deployment offers it. */
function LibraryControls({
  query,
  onQuery,
  arrangement,
  onArrangement,
}: {
  query: string;
  onQuery: (q: string) => void;
  arrangement: Arrangement;
  onArrangement: (a: Arrangement) => void;
}): JSX.Element | null {
  const { showSearch, sortOptions, groupOptions } = PRESENTATION.library;
  const showPicker = sortOptions.length + groupOptions.length > 1;
  if (!showSearch && !showPicker) return null;
  return (
    <div class="library-controls">
      {showSearch && (
        <input
          class="library-search"
          type="search"
          placeholder={`Search ${NOUNS.unitPlural}…`}
          value={query}
          onInput={(e) => onQuery((e.target as HTMLInputElement).value)}
          aria-label={`Search ${NOUNS.unitPlural} by title or ${NOUNS.collection ?? 'collection'}`}
        />
      )}
      {showPicker && (
        <select
          class="library-sort"
          value={arrangementValue(arrangement)}
          onChange={(e) => onArrangement(parseArrangement((e.target as HTMLSelectElement).value))}
          aria-label={`Arrange ${NOUNS.unitPlural}`}
        >
          {sortOptions.map((key) => (
            <option key={`sort:${key}`} value={`sort:${key}`}>
              {librarySortLabel(key, NOUNS.Unit)}
            </option>
          ))}
          {groupOptions.map((key) => (
            <option key={`group:${key}`} value={`group:${key}`}>
              {GROUP_LABELS[key]()}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Title, collection and description — the fields the old flat search matched. */
function matches(b: BookEntry, q: string): boolean {
  return (
    b.title.toLowerCase().includes(q) ||
    (b.group ?? '').toLowerCase().includes(q) ||
    (b.series ?? '').toLowerCase().includes(q) ||
    (b.description ?? '').toLowerCase().includes(q)
  );
}

/**
 * Sections rendered with whatever row/card the layout uses.
 *
 * `listClass` exists because the two layouts space their rows differently and
 * always did: flat rows are a flex column with a gap, series cards carry their
 * own margins in normal flow. A single list class would have quietly restyled
 * one of them the day this function replaced the two hand-written renderers.
 */
function Shelf({
  sections,
  row,
  listClass,
}: {
  sections: Section[];
  row: (book: BookEntry) => JSX.Element;
  listClass: string;
}): JSX.Element {
  const grid = PRESENTATION.library.view === 'grid';
  const list = (books: BookEntry[]): JSX.Element => (
    <ul class={grid ? 'library-grid' : listClass}>
      {books.map((book) => (
        <li key={book.id}>{grid ? <GridCard book={book} /> : row(book)}</li>
      ))}
    </ul>
  );
  if (sections.length === 1 && sections[0].name === null) return list(sections[0].books);
  return (
    <>
      {sections.map((section) => (
        <section key={section.name} class="series-section">
          <h2 class="group-title">{section.name}</h2>
          {list(section.books)}
        </section>
      ))}
    </>
  );
}

// ---- flat: standalone units ----

function StoryLibrary({ books }: { books: BookEntry[] }): JSX.Element {
  const [query, setQuery] = useState('');
  const [arrangement, setArrangement] = useLibraryArrangement();

  const q = query.trim().toLowerCase();
  let list = books.filter((b) => b.chapters.length > 0);
  if (q) list = list.filter((b) => matches(b, q));

  const sections =
    arrangement.kind === 'group'
      ? sectionsOf(list, arrangement.key, 'timeframe')
      : sectionsOf(list, 'none', arrangement.key);

  return (
    <>
      <LibraryControls query={query} onQuery={setQuery} arrangement={arrangement} onArrangement={setArrangement} />
      {list.length === 0 && <p class="empty-state">{fillCopy(PRESENTATION.emptyState.librarySearch, { query })}</p>}
      {/* Per-book `single` (design §3): a multi-chapter book in a flat library
          presents as a book — cover, then a chapter list — instead of being
          squeezed into a story row that could only open its first chapter.
          Absent (older manifests) keeps the layout-wide behaviour exactly. */}
      <Shelf
        sections={sections}
        listClass="story-list"
        row={(book) => (book.single === false ? <SeriesBookCard book={book} /> : <StoryRow book={book} chapter={book.chapters[0]} />)}
      />
    </>
  );
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
            {PRESENTATION.detail.showLength &&
              (chapter.hasAudio && chapter.audioDurationMs > 0
                ? `♪ ${fmtDuration(chapter.audioDurationMs)}`
                : (chapter.readingTime ?? `${chapter.wordCount} words`))}
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

/**
 * One unit as a cover card — presentation `library.view: "grid"`.
 *
 * Layout-agnostic: in a flat library it opens the unit, in a series library it
 * opens the collection, which is exactly what the corresponding row does.
 */
function GridCard({ book }: { book: BookEntry }): JSX.Element {
  const chapter = book.chapters[0];
  const pct = bookProgress(book);
  return (
    <button
      class="new-card"
      aria-label={`Open ${book.title}`}
      onClick={() =>
        (book.single ?? isStoryBrand()) && chapter && book.chapters.length === 1
          ? openItem(book.id, chapter.id)
          : navigate(`/library/${encodeURIComponent(book.id)}`)
      }
    >
      <span class="new-card-coverwrap">
        {book.cover ? (
          <img class="new-card-cover" src={contentUrl(book.cover)} alt="" loading="lazy" />
        ) : (
          <span class="new-card-cover new-cover-fallback" aria-hidden="true">
            {book.title.slice(0, 1)}
          </span>
        )}
        {pct > 0 && (
          <span class="new-card-progress" aria-hidden="true">
            <span class="new-card-progress-fill" style={{ width: `${Math.min(100, Math.round(pct * 100))}%` }} />
          </span>
        )}
      </span>
      <span class="new-card-title">{book.title}</span>
      {PRESENTATION.detail.showAuthor && book.author && <span class="new-card-subtitle">{book.author}</span>}
      {PRESENTATION.detail.showLength && (
        <span class="new-card-meta">
          {isStoryBrand() && chapter?.hasAudio && chapter.audioDurationMs > 0
            ? `♪ ${fmtDuration(chapter.audioDurationMs)}`
            : countUnits(book.chapters.length)}
        </span>
      )}
    </button>
  );
}

// ---- series: Series → Collection → chapters (Audible-like) ----

function SeriesLibrary({ books }: { books: BookEntry[] }): JSX.Element {
  const [query, setQuery] = useState('');
  const [arrangement, setArrangement] = useLibraryArrangement();

  const q = query.trim().toLowerCase();
  const list = q ? books.filter((b) => matches(b, q)) : books;

  const sections =
    arrangement.kind === 'group'
      ? sectionsOf(list, arrangement.key, 'order')
      : sectionsOf(list, 'none', arrangement.key);

  return (
    <>
      <LibraryControls query={query} onQuery={setQuery} arrangement={arrangement} onArrangement={setArrangement} />
      {list.length === 0 && <p class="empty-state">{fillCopy(PRESENTATION.emptyState.librarySearch, { query })}</p>}
      {/* Per-book `single` (design §3): a standalone story in a series library
          opens straight into its text like any story would, instead of showing
          a one-item chapter list. Absent keeps the old behaviour. */}
      <Shelf
        sections={sections}
        listClass="series-book-list"
        row={(book) =>
          book.single === true && book.chapters.length === 1 ? (
            <StoryRow book={book} chapter={book.chapters[0]} />
          ) : (
            <SeriesBookCard book={book} />
          )
        }
      />
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
        {PRESENTATION.detail.showAuthor && <span class="book-author">{book.author}</span>}
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
