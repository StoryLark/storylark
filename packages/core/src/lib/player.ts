// Global playback session — the single owner of the AudioController.
//
// Playback can start from anywhere (Home, Library, Book, Reader, Now Playing)
// and survives navigation: the Now Playing screen and the Reader's mini player
// both render off these signals. The Reader attaches its text container for
// word-sync highlighting in Read + Listen mode and detaches on unmount without
// interrupting audio.

import { signal } from '@preact/signals';
import type { BookEntry, ChapterContent, ChapterEntry, ChapterTimings, Progress } from './types';
import { manifest, settings, progressMap, progressKey } from './state';
import { saveProgress } from './progress-sync';
import { contentUrl } from '../brand';
import { isFlat } from '../presentation';
import { audioController } from '../reader/AudioController';
import { speechFallback } from '../reader/SpeechFallback';
import { setupMediaSession, updatePlaybackState } from './mediasession';
import { setWakeLock } from './wakelock';

/** Audio + timings for the user's chosen narrator; the chapter's base
 *  `audio`/`timings` are the library default voice. Applies on next load. */
export function chapterTrack(chapter: ChapterEntry): { audio?: string; timings?: string } {
  const v = settings.value.narratorVoice;
  const t = v ? chapter.voices?.[v] : undefined;
  return t ?? { audio: chapter.audio, timings: chapter.timings };
}

export interface NowPlayingItem {
  bookId: string;
  chapterId: string;
  bookTitle: string;
  chapterTitle: string;
  chapterLabel?: string;
  cover?: string;
  hasAudio: boolean;
}

export const nowPlaying = signal<NowPlayingItem | null>(null);
export const playerPlaying = signal(false);
export const playerPositionMs = signal(0);
export const playerDurationMs = signal(0);
export const playerRate = signal(1);
export const playerLoading = signal(false);

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

const SAVE_INTERVAL_MS = 30_000;
let lastSave = 0;
let activeContent: ChapterContent | null = null;
let activeTimings: ChapterTimings | null = null;
let attachedContainer: HTMLElement | null = null;

export function findEntry(bookId: string, chapterId: string): { book: BookEntry; chapter: ChapterEntry } | null {
  const book = manifest.value?.books.find((b) => b.id === bookId);
  const chapter = book?.chapters.find((c) => c.id === chapterId);
  return book && chapter ? { book, chapter } : null;
}

/** Next chapter in the book; for one-chapter (flat-library) books, the next book's unit. */
export function nextItem(bookId: string, chapterId: string): { bookId: string; chapterId: string } | null {
  const m = manifest.value;
  if (!m) return null;
  const bookIndex = m.books.findIndex((b) => b.id === bookId);
  const book = m.books[bookIndex];
  if (!book) return null;
  const i = book.chapters.findIndex((c) => c.id === chapterId);
  if (i >= 0 && i + 1 < book.chapters.length) return { bookId, chapterId: book.chapters[i + 1].id };
  if (book.chapters.length === 1 && bookIndex + 1 < m.books.length) {
    const nb = m.books[bookIndex + 1];
    if (nb.chapters[0]) return { bookId: nb.id, chapterId: nb.chapters[0].id };
  }
  return null;
}

function prevItem(bookId: string, chapterId: string): { bookId: string; chapterId: string } | null {
  const m = manifest.value;
  if (!m) return null;
  const bookIndex = m.books.findIndex((b) => b.id === bookId);
  const book = m.books[bookIndex];
  if (!book) return null;
  const i = book.chapters.findIndex((c) => c.id === chapterId);
  if (i > 0) return { bookId, chapterId: book.chapters[i - 1].id };
  if (book.chapters.length === 1 && bookIndex > 0) {
    const pb = m.books[bookIndex - 1];
    if (pb.chapters[0]) return { bookId: pb.id, chapterId: pb.chapters[0].id };
  }
  return null;
}

/**
 * Load an item into the player. Resumes from saved progress. When `autoplay`
 * is false the item is loaded paused (Read + Listen mode preloads this way).
 */
export async function startPlayback(bookId: string, chapterId: string, opts: { autoplay?: boolean } = {}): Promise<void> {
  const autoplay = opts.autoplay !== false;
  const current = nowPlaying.value;
  if (current && current.bookId === bookId && current.chapterId === chapterId && activeContent) {
    if (autoplay && !playerPlaying.value) void togglePlay();
    return;
  }

  const found = findEntry(bookId, chapterId);
  if (!found) return;
  const { book, chapter } = found;

  // Tear down whatever was playing.
  if (nowPlaying.value) void persistListen();
  speechFallback.stop();
  audioController.pause();

  nowPlaying.value = {
    bookId,
    chapterId,
    bookTitle: book.title,
    chapterTitle: chapter.title,
    chapterLabel: chapter.label,
    cover: book.cover,
    hasAudio: chapter.hasAudio,
  };
  playerPositionMs.value = 0;
  playerDurationMs.value = chapter.audioDurationMs || 0;
  playerLoading.value = true;
  activeContent = null;
  activeTimings = null;

  let content: ChapterContent;
  let timings: ChapterTimings | null = null;
  try {
    const res = await fetch(contentUrl(chapter.content));
    if (!res.ok) throw new Error(`content ${res.status}`);
    content = (await res.json()) as ChapterContent;
    const track = chapterTrack(chapter);
    if (track.timings) {
      const tRes = await fetch(contentUrl(track.timings)).catch(() => null);
      if (tRes?.ok) timings = (await tRes.json()) as ChapterTimings;
    }
  } catch {
    playerLoading.value = false;
    return;
  }
  // Bail if another item was loaded while we fetched.
  if (nowPlaying.value?.bookId !== bookId || nowPlaying.value?.chapterId !== chapterId) return;
  activeContent = content;
  activeTimings = timings;
  playerLoading.value = false;

  const audioPath = chapterTrack(chapter).audio;
  if (chapter.hasAudio && audioPath) {
    audioController.load(contentUrl(audioPath), content, timings, attachedContainer, {
      onTime: (ms, dur) => {
        playerPositionMs.value = ms;
        if (dur > 0) playerDurationMs.value = dur;
        const now = Date.now();
        if (now - lastSave >= SAVE_INTERVAL_MS) {
          lastSave = now;
          void persistListen(ms, dur);
        }
      },
      onPlayState: (p) => {
        playerPlaying.value = p;
        syncWakeLock();
        if (!p) void persistListen();
      },
      onEnded: () => {
        void persistListen();
        const next = nextItem(bookId, chapterId);
        if (!next) return;
        // Chapters within a book always flow; crossing into another book —
        // which flat-library brands present as the next story — is opt-in.
        if (next.bookId !== bookId && !settings.value.autoPlayNextStory) return;
        void startPlayback(next.bookId, next.chapterId);
      },
    });
    audioController.setReadAlongMode(settings.value.readAlong);
    audioController.setRate(playerRate.value);
    const saved = progressMap.value.get(progressKey(bookId, chapterId));
    if (saved && saved.audioMs > 0 && saved.percent < 0.99) {
      audioController.seekMs(saved.audioMs);
      playerPositionMs.value = saved.audioMs;
    }
    wireMediaSession(book, chapter, bookId, chapterId);
    if (autoplay) await audioController.play().catch(() => undefined);
    // Save right away so Home's Continue card shows this item immediately,
    // not only after the first 30s interval tick or the first pause.
    void persistListen();
  } else if (autoplay && speechFallback.supported) {
    startFallback();
  }
}

function wireMediaSession(book: BookEntry, chapter: ChapterEntry, bookId: string, chapterId: string): void {
  const prev = prevItem(bookId, chapterId);
  const next = nextItem(bookId, chapterId);
  setupMediaSession({
    title: chapter.title,
    book: book.title,
    cover: book.cover,
    onPlay: () => void audioController.play(),
    onPause: () => audioController.pause(),
    onSeek: (d) => audioController.seekDelta(d),
    onPrev: prev ? () => void startPlayback(prev.bookId, prev.chapterId) : undefined,
    onNext: next ? () => void startPlayback(next.bookId, next.chapterId) : undefined,
  });
}

function startFallback(): void {
  const item = nowPlaying.value;
  if (!item || !activeContent) return;
  const saved = progressMap.value.get(progressKey(item.bookId, item.chapterId));
  const fromBlock = saved && saved.charOffset > 0 ? blockAtCharOffset(activeContent, saved.charOffset) : null;
  speechFallback.start(
    activeContent,
    attachedContainer,
    fromBlock,
    // Device-voice items have no audio track, so persistListen can't track
    // them — save block-level progress here so Home's Continue card works
    // and resuming restarts from the right block.
    (blockId) => void persistFallback(blockId),
    () => {
      void persistFallback(null, 1);
      playerPlaying.value = false;
      syncWakeLock();
      updatePlaybackState('none');
    }
  );
  playerPlaying.value = true;
  syncWakeLock();
  updatePlaybackState('playing');
  void persistFallback(fromBlock);
}

/** Persist progress for device-voice (no audio track) playback, keyed by block. */
async function persistFallback(blockId: string | null, donePercent?: number): Promise<void> {
  const item = nowPlaying.value;
  if (!item || item.hasAudio || !activeContent) return;
  const charOffset = blockId ? charOffsetOfBlock(activeContent, blockId) : 0;
  const total = totalChars(activeContent);
  const p: Progress = {
    bookId: item.bookId,
    chapterId: item.chapterId,
    mode: 'listen',
    charOffset,
    audioMs: 0,
    percent: donePercent ?? (total > 0 ? charOffset / total : 0),
    updatedAt: Date.now(),
  };
  await saveProgress(p);
}

export function togglePlay(): void {
  const item = nowPlaying.value;
  if (!item) return;
  if (item.hasAudio) {
    if (audioController.playing) audioController.pause();
    else void audioController.play().catch(() => undefined);
  } else if (speechFallback.supported) {
    if (speechFallback.active) {
      speechFallback.stop();
      playerPlaying.value = false;
      syncWakeLock();
      updatePlaybackState('none');
    } else {
      startFallback();
    }
  }
}

export function seekTo(ms: number): void {
  if (!nowPlaying.value?.hasAudio) return;
  audioController.seekMs(ms);
  playerPositionMs.value = Math.max(0, ms);
}

export function skip(deltaSec: number): void {
  if (!nowPlaying.value?.hasAudio) return;
  audioController.seekDelta(deltaSec);
  playerPositionMs.value = audioController.currentMs;
}

export function setRate(rate: number): void {
  playerRate.value = rate;
  audioController.setRate(rate);
}

export function cycleRate(): void {
  const i = PLAYBACK_RATES.indexOf(playerRate.value);
  setRate(PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length]);
}

export function stopPlayback(): void {
  setWakeLock(false);
  void persistListen();
  speechFallback.stop();
  audioController.dispose();
  nowPlaying.value = null;
  playerPlaying.value = false;
  playerPositionMs.value = 0;
  playerDurationMs.value = 0;
  activeContent = null;
  activeTimings = null;
  updatePlaybackState('none');
}

/** Reader (Read + Listen) attaches its text container for highlighting. */
export function attachContainer(el: HTMLElement | null): void {
  attachedContainer = el;
  audioController.setContainer(el);
  syncWakeLock();
}

/** Hold the screen awake only while read-along is actually on screen:
 *  narration playing AND the Reader's text attached for highlighting AND the
 *  Keep-screen-awake setting on. Exported so Settings can re-sync on toggle. */
export function syncWakeLock(): void {
  setWakeLock(settings.value.keepAwake && playerPlaying.value && attachedContainer !== null);
}

async function persistListen(ms?: number, dur?: number): Promise<void> {
  const item = nowPlaying.value;
  if (!item || !item.hasAudio) return;
  const posMs = ms ?? audioController.currentMs;
  const durMs = dur ?? audioController.durationMs;
  const p: Progress = {
    bookId: item.bookId,
    chapterId: item.chapterId,
    mode: 'listen',
    charOffset: 0,
    audioMs: Math.floor(posMs),
    percent: durMs > 0 ? posMs / durMs : 0,
    updatedAt: Date.now(),
  };
  await saveProgress(p);
}

function blockTextLength(b: ChapterContent['blocks'][number]): number {
  return 'text' in b && typeof b.text === 'string'
    ? b.text.length
    : b.type === 'message-block'
      ? b.messages.reduce((n, m) => n + m.text.length, 0)
      : 0;
}

/** Cumulative char offset at the start of a block (inverse of blockAtCharOffset). */
function charOffsetOfBlock(content: ChapterContent, blockId: string): number {
  let cursor = 0;
  for (const b of content.blocks) {
    if (b.id === blockId) return cursor;
    cursor += blockTextLength(b);
  }
  return 0;
}

function totalChars(content: ChapterContent): number {
  return content.charLength > 0 ? content.charLength : content.blocks.reduce((n, b) => n + blockTextLength(b), 0);
}

/** First block whose cumulative char range contains the offset. */
export function blockAtCharOffset(content: ChapterContent, charOffset: number): string | null {
  let cursor = 0;
  for (const b of content.blocks) {
    const len = blockTextLength(b);
    if (charOffset < cursor + len) return b.id;
    cursor += len;
  }
  return content.blocks[0]?.id ?? null;
}

// Persist the in-flight listening position the moment the app is backgrounded
// or closed — the 30s interval alone can lose up to 30s of progress and leaves
// Home's Continue card stale when the user navigates away mid-play.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void persistListen();
  });
  window.addEventListener('pagehide', () => void persistListen());
}

export function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * True when this library's UI treats every book as a standalone unit.
 *
 * Kept under its old name because half the app reads it, but the answer now
 * comes from the PRESENTATION contract rather than from the brand, so it can
 * change at runtime along with everything else about the library's shape
 * (AB#7416). `isFlat()` in ../presentation is the same question for new code.
 */
export function isStoryBrand(): boolean {
  return isFlat();
}
