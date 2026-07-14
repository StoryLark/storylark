import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ChapterContent, ChapterTimings, ConsumptionMode, Progress } from '../lib/types';
import { manifest, progressMap, progressKey, modeFor, setItemMode } from '../lib/state';
import { saveProgress } from '../lib/progress-sync';
import { contentUrl, NOUNS } from '../brand';
import { navigate } from '../router';
import { BlockRenderer } from '../reader/BlockRenderer';
import { audioController } from '../reader/AudioController';
import {
  startPlayback,
  attachContainer,
  togglePlay,
  skip,
  seekTo,
  playerPlaying,
  playerPositionMs,
  playerDurationMs,
  nowPlaying,
  blockAtCharOffset,
  isStoryBrand,
  fmtTime,
} from '../lib/player';

const SAVE_INTERVAL_MS = 30_000;

export function Reader({ bookId, chapterId, mode: routeMode }: { bookId: string; chapterId: string; mode?: 'read' | 'both' }): JSX.Element {
  const [content, setContent] = useState<ChapterContent | null>(null);
  const [timings, setTimings] = useState<ChapterTimings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'read' | 'both'>(() => {
    if (routeMode) return routeMode;
    const remembered = modeFor(bookId, chapterId);
    return remembered === 'both' ? 'both' : 'read';
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const lastSaveRef = useRef(0);
  // Last position measured while the DOM was live — persisted on unmount and
  // pagehide, when the container may already be detached (rects read as 0).
  const lastPosRef = useRef<{ charOffset: number; percent: number } | null>(null);

  const book = manifest.value?.books.find((b) => b.id === bookId);
  const chapter = book?.chapters.find((c) => c.id === chapterId);
  const chapterIndex = book?.chapters.findIndex((c) => c.id === chapterId) ?? -1;
  const prevChapter = chapterIndex > 0 ? book?.chapters[chapterIndex - 1] : undefined;
  const nextChapter = chapterIndex >= 0 ? book?.chapters[chapterIndex + 1] : undefined;

  // Load chapter content + timings (download cache first via SW, then network).
  useEffect(() => {
    if (!chapter) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(contentUrl(chapter.content));
        if (!res.ok) throw new Error(`content ${res.status}`);
        const c = (await res.json()) as ChapterContent;
        if (cancelled) return;
        setContent(c);
        if (chapter.timings) {
          const tRes = await fetch(contentUrl(chapter.timings)).catch(() => null);
          if (!cancelled && tRes?.ok) setTimings((await tRes.json()) as ChapterTimings);
        }
      } catch {
        if (!cancelled) setError(`This ${NOUNS.unit} is not available offline yet. Connect and try again.`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId, chapterId, chapter?.contentHash]);

  // Restore saved position once content renders.
  useEffect(() => {
    if (!content || !containerRef.current) return;
    const saved = progressMap.value.get(progressKey(bookId, chapterId));
    if (saved && saved.mode === 'read' && saved.charOffset > 0) {
      const blockId = blockAtCharOffset(content, saved.charOffset);
      if (blockId) {
        containerRef.current.querySelector(`[data-block-id="${blockId}"]`)?.scrollIntoView({ block: 'start' });
      }
    }
  }, [content]);

  // Track the reading position in read mode. Every scroll updates the
  // in-memory position (throttled); IndexedDB writes happen on the 30s
  // interval AND on unmount / tab-switch / app-hide, so leaving the Reader by
  // any route — tab bar, next-chapter, closing the app — keeps the position
  // for Home's Continue card. (Previously only the back button saved it.)
  useEffect(() => {
    if (!content || mode !== 'read') return;
    const el = containerRef.current;
    if (!el) return;
    lastPosRef.current = visibleCharOffset(content, el);
    let lastMeasure = 0;
    const onScroll = (): void => {
      const now = Date.now();
      if (now - lastMeasure < 1000) return;
      lastMeasure = now;
      lastPosRef.current = visibleCharOffset(content, containerRef.current);
      if (now - lastSaveRef.current < SAVE_INTERVAL_MS) return;
      lastSaveRef.current = now;
      void persistRead();
    };
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') void persistRead();
    };
    const onPageHide = (): void => void persistRead();
    document.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      void persistRead();
    };
  }, [content, mode]);

  async function persistRead(): Promise<void> {
    if (!content) return;
    // Prefer a live measurement; fall back to the last one taken while the
    // container was attached (unmount path).
    const live = containerRef.current?.isConnected ? visibleCharOffset(content, containerRef.current) : null;
    const info = live ?? lastPosRef.current;
    if (!info) return;
    const p: Progress = {
      bookId,
      chapterId,
      mode: 'read',
      charOffset: info.charOffset,
      audioMs: 0,
      percent: info.percent,
      updatedAt: Date.now(),
    };
    await saveProgress(p);
  }

  // READ + LISTEN: load the item into the global player (paused unless it's
  // already playing) and attach this text container for word-sync highlight.
  useEffect(() => {
    if (mode !== 'both' || !content || !chapter || !containerRef.current) return;
    attachContainer(containerRef.current);
    void startPlayback(bookId, chapterId, { autoplay: false });
    return () => {
      // Detach the highlight only — audio keeps going (Now Playing owns it).
      attachContainer(null);
    };
  }, [mode, content, chapter?.id]);

  function switchMode(next: ConsumptionMode): void {
    void setItemMode(bookId, chapterId, next);
    if (next === 'listen') {
      void startPlayback(bookId, chapterId);
      navigate('/now-playing');
      return;
    }
    if (next === 'read' && mode === 'both') {
      // Text-only: pause audio; it stays loaded in Now Playing for later.
      if (playerPlaying.value) togglePlay();
    }
    setMode(next);
    navigate(`/read/${encodeURIComponent(bookId)}/${encodeURIComponent(chapterId)}?mode=${next}`, true);
  }

  function onTextClick(e: MouseEvent): void {
    if (mode !== 'both' || !timings) return;
    const target = e.target as HTMLElement;
    const wordSpan = target.closest<HTMLElement>('.ra-word');
    const blockEl = target.closest<HTMLElement>('[data-block-id]');
    if (wordSpan && blockEl && content) {
      const blockId = blockEl.dataset.blockId!;
      const timing = timings.blocks.find((b) => b.blockId === blockId);
      const w = timing?.words[Number(wordSpan.dataset.w)];
      if (w) audioController.seekMs(w[2]);
    }
  }

  if (!chapter) {
    return (
      <div class="screen">
        <p class="empty-state">{NOUNS.Unit} not found.</p>
      </div>
    );
  }

  const backTarget = isStoryBrand() ? '/library' : `/library/${encodeURIComponent(bookId)}`;
  const playingThis = nowPlaying.value?.bookId === bookId && nowPlaying.value?.chapterId === chapterId;

  return (
    <div class="screen reader-screen">
      <header class="reader-header">
        <button
          class="icon-btn"
          onClick={() => {
            if (mode === 'read') void persistRead();
            navigate(backTarget);
          }}
          aria-label="Back"
        >
          ←
        </button>
        <div class="reader-heading">
          {chapter.label && <span class="reader-label">{chapter.label}</span>}
          <span class="reader-title">{chapter.title}</span>
        </div>
        <div class="mode-seg" role="group" aria-label="Reading mode">
          <button class={`mode-seg-btn${mode === 'read' ? ' active' : ''}`} onClick={() => switchMode('read')} title="Read">
            ☰
          </button>
          <button class={`mode-seg-btn${mode === 'both' ? ' active' : ''}`} onClick={() => switchMode('both')} title="Read + Listen">
            ☰♪
          </button>
          <button class="mode-seg-btn" onClick={() => switchMode('listen')} title="Listen">
            ♪
          </button>
        </div>
      </header>

      {chapter.setting && <p class="chapter-setting">{chapter.setting}</p>}
      {error && <p class="empty-state">{error}</p>}
      {!content && !error && <p class="empty-state">Loading…</p>}

      {content && (
        <div class="chapter-body" ref={containerRef} onClick={onTextClick}>
          {content.blocks.map((block, i) => (
            <BlockRenderer key={block.id} block={block} first={i === 0 || content.blocks[i - 1]?.type === 'scene-break'} />
          ))}
        </div>
      )}

      {content && (
        <nav class="chapter-nav">
          {prevChapter ? (
            <button class="nav-btn" onClick={() => navigate(`/read/${bookId}/${prevChapter.id}?mode=${mode}`)}>
              ← {prevChapter.title}
            </button>
          ) : (
            <span />
          )}
          {nextChapter ? (
            <button class="nav-btn" onClick={() => navigate(`/read/${bookId}/${nextChapter.id}?mode=${mode}`)}>
              {nextChapter.title} →
            </button>
          ) : (
            <span />
          )}
        </nav>
      )}

      {mode === 'both' && content && (
        <div class="player-bar">
          <button class="icon-btn" onClick={() => skip(-15)} aria-label="Back 15 seconds">
            ↺15
          </button>
          <button class="play-btn" onClick={togglePlay} aria-label={playerPlaying.value && playingThis ? 'Pause' : 'Play'}>
            {playerPlaying.value && playingThis ? '❚❚' : '▶'}
          </button>
          <button class="icon-btn" onClick={() => skip(15)} aria-label="Forward 15 seconds">
            15↻
          </button>
          <div class="player-track" onClick={(e) => scrubTo(e, playerDurationMs.value)}>
            <div
              class="player-fill"
              style={{ width: playerDurationMs.value ? `${(playerPositionMs.value / playerDurationMs.value) * 100}%` : '0%' }}
            />
          </div>
          <span class="player-time">
            {fmtTime(playerPositionMs.value)} / {fmtTime(playerDurationMs.value)}
          </span>
        </div>
      )}
    </div>
  );

  function scrubTo(e: MouseEvent, dur: number): void {
    const track = e.currentTarget as HTMLElement;
    const rect = track.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    seekTo(frac * dur);
  }
}

/** Approximate reading position: the first block currently in the viewport. */
function visibleCharOffset(content: ChapterContent, container: HTMLElement | null): { charOffset: number; percent: number } {
  if (!container) return { charOffset: 0, percent: 0 };
  const blocks = container.querySelectorAll<HTMLElement>('[data-block-id]');
  let activeId: string | null = null;
  for (const el of blocks) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > 80) {
      activeId = el.dataset.blockId ?? null;
      break;
    }
  }
  let cursor = 0;
  let total = 0;
  let found = 0;
  for (const b of content.blocks) {
    const len = 'text' in b && typeof b.text === 'string' ? b.text.length : b.type === 'message-block' ? b.messages.reduce((n, m) => n + m.text.length, 0) : 0;
    if (b.id === activeId) found = cursor;
    cursor += len;
    total += len;
  }
  return { charOffset: found, percent: total > 0 ? found / total : 0 };
}
