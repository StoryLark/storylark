import type { JSX } from 'preact';
import { manifest, progressMap, progressKey, modeFor } from '../lib/state';
import { fmtDuration, isStoryBrand, startPlayback, nextItem } from '../lib/player';
import { openItem } from '../lib/open-item';
import { navigate } from '../router';
import { BRAND, NOUNS, contentUrl } from '../brand';
import { PreviewBanner } from '../components/PreviewBanner';
import type { ChapterEntry, Progress } from '../lib/types';

export function Home(): JSX.Element {
  const m = manifest.value;
  return (
    <div class="screen home-screen">
      <header class="home-header">
        <img class="home-logo" src="/icons/icon-192.png" alt="" width="56" height="56" />
        <div>
          <h1 class="app-title">{BRAND.appName}</h1>
          <p class="app-tagline">{BRAND.tagline}</p>
        </div>
      </header>

      <PreviewBanner />

      {!m && <p class="empty-state">Loading the library…</p>}
      {m && (
        <>
          <ContinueCard />
          <NewSection />
        </>
      )}
    </div>
  );
}

/**
 * Most recently touched item, straight from the LOCAL progress store — works
 * signed out. Records exist only after the user opens something, so 0% counts
 * too (previously 0% records were filtered out and the card came up empty).
 */
function latestProgress(): Progress | null {
  let best: Progress | null = null;
  for (const p of progressMap.value.values()) {
    if (!best || p.updatedAt > best.updatedAt) best = p;
  }
  return best;
}

function ContinueCard(): JSX.Element | null {
  const p = latestProgress();
  if (!p) return null;

  // Finished the last item? Point the card at what comes next instead.
  const finished = p.percent >= 0.995;
  let target = { bookId: p.bookId, chapterId: p.chapterId };
  let upNext = false;
  if (finished) {
    const next = nextItem(p.bookId, p.chapterId);
    if (!next) return null;
    target = next;
    upNext = true;
  }

  const book = manifest.value?.books.find((b) => b.id === target.bookId);
  const chapter = book?.chapters.find((c) => c.id === target.chapterId);
  if (!book || !chapter) return null;

  const resume = (): void => {
    if (upNext) {
      openItem(target.bookId, target.chapterId);
      return;
    }
    if (p.mode === 'listen') {
      // startPlayback restores the exact saved audio position (audioMs); for
      // device-voice items it restarts from the saved block (charOffset).
      void startPlayback(p.bookId, p.chapterId);
      navigate('/now-playing');
    } else {
      // Saved position is a reading position — resume into the Reader even if
      // the global default mode is Listen. The Reader scrolls to charOffset.
      const m = modeFor(p.bookId, p.chapterId) === 'both' ? 'both' : 'read';
      navigate(`/read/${encodeURIComponent(p.bookId)}/${encodeURIComponent(p.chapterId)}?mode=${m}`);
    }
  };

  const pct = upNext ? 0 : Math.max(0, Math.min(100, Math.round(p.percent * 100)));
  return (
    <section class="home-section">
      <h2 class="home-section-title">{upNext ? 'Up next' : 'Continue'}</h2>
      <button class="continue-card" onClick={resume}>
        {book.cover ? (
          <img class="continue-cover" src={contentUrl(book.cover)} alt="" loading="lazy" />
        ) : (
          <span class="continue-cover continue-cover-fallback" aria-hidden="true">
            {book.title.slice(0, 1)}
          </span>
        )}
        <span class="continue-body">
          <span class="continue-book">{book.title}</span>
          {!isStoryBrand() && (
            <span class="continue-chapter">
              {chapter.label ? `${chapter.label}: ` : ''}
              {chapter.title}
            </span>
          )}
          {isStoryBrand() && book.group && <span class="continue-chapter">{book.group}</span>}
          <span class="continue-meta">
            {upNext ? `New ${NOUNS.unit} ready` : `${p.mode === 'listen' ? '♪ Listening' : '☰ Reading'} · ${pct}%`}
          </span>
          {!upNext && (
            <span class="chapter-progress">
              <span class="chapter-progress-fill" style={{ width: `${pct}%` }} />
            </span>
          )}
        </span>
        <span class="continue-resume" aria-hidden="true">
          ▶
        </span>
      </button>
    </section>
  );
}

interface NewItem {
  bookId: string;
  chapterId: string;
  title: string;
  subtitle: string;
  cover?: string;
  date?: string;
  meta: string;
}

/** Recently added stories (gunner) or chapters (holdfast), newest first. */
function newItems(): NewItem[] {
  const m = manifest.value;
  if (!m) return [];
  const items: NewItem[] = [];
  if (isStoryBrand()) {
    for (const book of m.books) {
      const ch = book.chapters[0];
      if (!ch) continue;
      items.push({
        bookId: book.id,
        chapterId: ch.id,
        title: book.title,
        subtitle: book.group ?? '',
        cover: book.cover,
        date: book.publishDate ?? ch.publishedAt,
        meta: metaFor(ch),
      });
    }
  } else {
    for (const book of m.books) {
      for (const ch of book.chapters) {
        items.push({
          bookId: book.id,
          chapterId: ch.id,
          title: ch.title,
          subtitle: `${ch.label ? `${ch.label} · ` : ''}${book.title}`,
          cover: book.cover,
          date: ch.publishedAt,
          meta: metaFor(ch),
        });
      }
    }
  }
  // publishedAt/publishDate may be missing (older manifests) — undated items
  // keep manifest order and sort after dated ones.
  const dated = items.filter((i) => i.date);
  const undated = items.filter((i) => !i.date);
  dated.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return [...dated, ...undated].slice(0, 10);
}

function metaFor(ch: ChapterEntry): string {
  if (ch.hasAudio && ch.audioDurationMs > 0) return `♪ ${fmtDuration(ch.audioDurationMs)}`;
  return ch.readingTime ?? `${ch.wordCount} words`;
}

const NEW_BADGE_DAYS = 14;

function isRecent(iso?: string): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && Date.now() - t < NEW_BADGE_DAYS * 24 * 60 * 60 * 1000;
}

/** Horizontally swipeable cover-card carousel (CSS scroll-snap, no JS lib). */
function NewSection(): JSX.Element | null {
  const items = newItems();
  if (items.length === 0) return null;
  return (
    <section class="home-section">
      <div class="home-section-head">
        <h2 class="home-section-title">New {NOUNS.unitPlural}</h2>
        <button class="btn-ghost home-see-all" onClick={() => navigate('/library')}>
          See all →
        </button>
      </div>
      <ul class="new-carousel" aria-label={`New ${NOUNS.unitPlural}`}>
        {items.map((item) => (
          <li key={`${item.bookId}/${item.chapterId}`} class="new-card-slot">
            <button class="new-card" onClick={() => openItem(item.bookId, item.chapterId)} aria-label={`Open ${item.title}`}>
              <span class="new-card-coverwrap">
                {item.cover ? (
                  <img class="new-card-cover" src={contentUrl(item.cover)} alt="" loading="lazy" />
                ) : (
                  <span class="new-card-cover new-cover-fallback" aria-hidden="true">
                    {item.title.slice(0, 1)}
                  </span>
                )}
                {isRecent(item.date) && <span class="new-card-badge">New</span>}
                <CardProgress bookId={item.bookId} chapterId={item.chapterId} />
              </span>
              <span class="new-card-title">{item.title}</span>
              {item.subtitle && <span class="new-card-subtitle">{item.subtitle}</span>}
              <span class="new-card-meta">
                {item.meta}
                {item.date && ` · ${fmtDate(item.date)}`}
              </span>
            </button>
          </li>
        ))}
        <li class="new-card-slot">
          <button class="new-card new-card-more" onClick={() => navigate('/library')} aria-label="Browse the full library">
            <span class="new-card-coverwrap new-card-more-cover" aria-hidden="true">
              →
            </span>
            <span class="new-card-title">Full library</span>
          </button>
        </li>
      </ul>
    </section>
  );
}

function CardProgress({ bookId, chapterId }: { bookId: string; chapterId: string }): JSX.Element | null {
  const p = progressMap.value.get(progressKey(bookId, chapterId));
  if (!p || p.percent <= 0) return null;
  return (
    <span class="new-card-progress" aria-hidden="true">
      <span class="new-card-progress-fill" style={{ width: `${Math.min(100, Math.round(p.percent * 100))}%` }} />
    </span>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
