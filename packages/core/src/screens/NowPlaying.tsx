import type { JSX } from 'preact';
import {
  nowPlaying,
  playerPlaying,
  playerPositionMs,
  playerDurationMs,
  playerRate,
  playerLoading,
  togglePlay,
  seekTo,
  skip,
  cycleRate,
  startPlayback,
  isStoryBrand,
  fmtTime,
} from '../lib/player';
import { manifest } from '../lib/state';
import { navigate } from '../router';
import { contentUrl } from '../brand';
import { NOUNS, PRESENTATION, fillCopy } from '../presentation';

/**
 * Skip distance, from presentation `player.skipSeconds` (AB#7416).
 *
 * Read once at module scope rather than per render: the presentation is
 * resolved before any component mounts and cannot change without a document
 * load, so this is a constant with a configurable value, not state.
 */
const SKIP = PRESENTATION.player.skipSeconds;

export function NowPlaying(): JSX.Element {
  const item = nowPlaying.value;

  if (!item) {
    return (
      <div class="screen np-screen">
        <header class="screen-header">
          <h1 class="screen-title">Now Playing</h1>
        </header>
        <div class="np-empty">
          <p class="empty-state">{fillCopy(PRESENTATION.emptyState.nowPlaying)}</p>
          <button class="btn" onClick={() => navigate('/library')}>
            Pick something from the library
          </button>
        </div>
      </div>
    );
  }

  const pos = playerPositionMs.value;
  const dur = playerDurationMs.value;

  return (
    <div class="screen np-screen">
      <header class="screen-header">
        <h1 class="screen-title">Now Playing</h1>
      </header>

      <div class="np-art-wrap">
        {item.cover ? (
          <img class="np-art" src={contentUrl(item.cover)} alt="" />
        ) : (
          <img class="np-art np-art-icon" src="/icons/icon-512.png" alt="" />
        )}
      </div>

      <div class="np-titles">
        {item.chapterLabel && <span class="reader-label">{item.chapterLabel}</span>}
        <h2 class="np-chapter">{item.chapterTitle}</h2>
        <p class="np-book">{item.bookTitle}</p>
        <span class="np-mode-chip">
          {item.hasAudio ? '♪ Listen' : '♪ Listen (device voice)'}
        </span>
      </div>

      {item.hasAudio ? (
        <div class="np-scrub">
          <input
            class="np-slider"
            type="range"
            min="0"
            max={String(Math.max(dur, 1))}
            step="1000"
            value={String(Math.min(pos, dur))}
            onInput={(e) => seekTo(Number((e.target as HTMLInputElement).value))}
            aria-label="Seek"
          />
          <div class="np-times">
            <span>{fmtTime(pos)}</span>
            <span>-{fmtTime(Math.max(0, dur - pos))}</span>
          </div>
        </div>
      ) : (
        <p class="settings-note np-fallback-note">
          This item has no narration track yet. Playback uses your device's built-in voice, so seeking isn't available.
        </p>
      )}

      <div class="np-controls">
        {/*
          The speed dial and the skip distance are presentation (AB#7416): an
          opinionated audiobook brand may not want a speed control at all, and
          15 seconds is a convention rather than a law. The defaults are what
          this transport has always done — dial shown, ±15s.
        */}
        {PRESENTATION.player.showSpeed && (
          <button class="np-rate" onClick={cycleRate} aria-label="Playback speed" disabled={!item.hasAudio}>
            {playerRate.value}×
          </button>
        )}
        <button class="np-skip" onClick={() => skip(-SKIP)} aria-label={`Back ${SKIP} seconds`} disabled={!item.hasAudio}>
          ↺{SKIP}
        </button>
        <button class="np-play" onClick={togglePlay} aria-label={playerPlaying.value ? 'Pause' : 'Play'} disabled={playerLoading.value}>
          {playerLoading.value ? '…' : playerPlaying.value ? '❚❚' : '▶'}
        </button>
        <button class="np-skip" onClick={() => skip(SKIP)} aria-label={`Forward ${SKIP} seconds`} disabled={!item.hasAudio}>
          {SKIP}↻
        </button>
        <button
          class="np-readalong"
          aria-label="Read along"
          onClick={() => navigate(`/read/${encodeURIComponent(item.bookId)}/${encodeURIComponent(item.chapterId)}?mode=both`)}
        >
          ☰
        </button>
      </div>

      <ChapterPicker currentBookId={item.bookId} currentChapterId={item.chapterId} />
    </div>
  );
}

function ChapterPicker({ currentBookId, currentChapterId }: { currentBookId: string; currentChapterId: string }): JSX.Element | null {
  const m = manifest.value;
  if (!m) return null;

  // flat: pick across all units; series: pick within the current collection.
  const options: { value: string; label: string }[] = [];
  if (isStoryBrand()) {
    for (const b of m.books) {
      const ch = b.chapters[0];
      if (ch) options.push({ value: `${b.id}/${ch.id}`, label: b.title });
    }
  } else {
    const book = m.books.find((b) => b.id === currentBookId);
    if (!book || book.chapters.length < 2) return null;
    for (const ch of book.chapters) {
      options.push({ value: `${book.id}/${ch.id}`, label: ch.label ? `${ch.label}: ${ch.title}` : ch.title });
    }
  }
  if (options.length < 2) return null;

  return (
    <label class="np-picker">
      <span class="np-picker-label">{NOUNS.Unit}</span>
      <select
        value={`${currentBookId}/${currentChapterId}`}
        onChange={(e) => {
          const [bookId, chapterId] = (e.target as HTMLSelectElement).value.split('/');
          void startPlayback(bookId, chapterId);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
