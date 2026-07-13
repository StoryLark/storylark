import type { ChapterContent, ChapterTimings } from '../lib/types';
import { flattenTimings, wordAtTime, spanifyBlock, unspanifyBlock, type FlatWord } from './Highlighter';
import { updatePlaybackState } from '../lib/mediasession';

export interface AudioCallbacks {
  onTime?: (ms: number, durationMs: number) => void;
  onPlayState?: (playing: boolean) => void;
  onEnded?: () => void;
}

/**
 * Owns the single <audio> element and drives the read-along highlight via a
 * requestAnimationFrame loop (timeupdate only fires ~4 Hz — too coarse).
 * The element is created once and reused across chapters (iOS keeps
 * background audio alive only for the element that started playing).
 */
export class AudioController {
  private audio: HTMLAudioElement;
  private flat: FlatWord[] = [];
  private timings: ChapterTimings | null = null;
  private content: ChapterContent | null = null;
  private raf = 0;
  private activeWord = -1;
  private activeBlockIndex = -1;
  private activeSpans: HTMLElement[] = [];
  private container: HTMLElement | null = null;
  private userScrolledAt = 0;
  private cb: AudioCallbacks = {};
  private mode: 'word' | 'block' | 'off' = 'word';

  constructor() {
    this.audio = document.createElement('audio');
    this.audio.preload = 'metadata';
    this.audio.addEventListener('play', () => {
      this.startLoop();
      updatePlaybackState('playing');
      this.cb.onPlayState?.(true);
    });
    this.audio.addEventListener('pause', () => {
      this.stopLoop();
      updatePlaybackState('paused');
      this.cb.onPlayState?.(false);
    });
    this.audio.addEventListener('ended', () => {
      this.stopLoop();
      updatePlaybackState('none');
      this.cb.onEnded?.();
    });
  }

  load(src: string, content: ChapterContent, timings: ChapterTimings | null, container: HTMLElement | null, cb: AudioCallbacks): void {
    this.clearHighlight();
    this.detachContainer();
    const rate = this.audio.playbackRate || 1;
    this.audio.src = src;
    this.audio.playbackRate = rate; // changing src resets playbackRate in some browsers
    this.content = content;
    this.timings = timings;
    this.flat = timings ? flattenTimings(timings) : [];
    this.container = container;
    this.cb = cb;
    this.activeWord = -1;
    this.activeBlockIndex = -1;
    container?.addEventListener('wheel', this.noteUserScroll, { passive: true });
    container?.addEventListener('touchmove', this.noteUserScroll, { passive: true });
  }

  /**
   * Swap the DOM container the highlight runs against without touching
   * playback — lets the Now Playing screen keep audio going while the Reader
   * mounts/unmounts its text (Read + Listen mode).
   */
  setContainer(container: HTMLElement | null): void {
    if (container === this.container) return;
    this.clearHighlight();
    this.detachContainer();
    this.container = container;
    this.activeWord = -1;
    this.activeBlockIndex = -1;
    container?.addEventListener('wheel', this.noteUserScroll, { passive: true });
    container?.addEventListener('touchmove', this.noteUserScroll, { passive: true });
  }

  private detachContainer(): void {
    this.container?.removeEventListener('wheel', this.noteUserScroll);
    this.container?.removeEventListener('touchmove', this.noteUserScroll);
    this.container = null;
  }

  setReadAlongMode(mode: 'word' | 'block' | 'off'): void {
    this.mode = mode;
    if (mode === 'off') this.clearHighlight();
  }

  play(): Promise<void> {
    return this.audio.play();
  }
  pause(): void {
    this.audio.pause();
  }
  get playing(): boolean {
    return !this.audio.paused;
  }
  get currentMs(): number {
    return this.audio.currentTime * 1000;
  }
  get durationMs(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : this.timings?.durationMs ?? 0;
  }
  seekMs(ms: number): void {
    this.audio.currentTime = Math.max(0, ms) / 1000;
  }
  seekDelta(deltaSec: number): void {
    this.seekMs(this.currentMs + deltaSec * 1000);
  }
  setRate(rate: number): void {
    this.audio.playbackRate = rate;
    this.audio.defaultPlaybackRate = rate;
  }
  get rate(): number {
    return this.audio.playbackRate || 1;
  }

  /** Seek to the word at a char offset within a block (tap-a-word). */
  seekToWord(blockId: string, charOffset: number): void {
    if (!this.timings) return;
    const blockIndex = this.timings.blocks.findIndex((b) => b.blockId === blockId);
    if (blockIndex < 0) return;
    const words = this.timings.blocks[blockIndex].words;
    const hit = words.find(([cs, ce]) => charOffset >= cs && charOffset < ce) ?? words[0];
    if (hit) this.seekMs(hit[2]);
  }

  dispose(): void {
    this.pause();
    this.stopLoop();
    this.clearHighlight();
    this.detachContainer();
    this.cb = {};
  }

  private noteUserScroll = (): void => {
    this.userScrolledAt = Date.now();
  };

  private startLoop(): void {
    this.stopLoop();
    const tick = (): void => {
      this.updateHighlight();
      this.cb.onTime?.(this.currentMs, this.durationMs);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private updateHighlight(): void {
    if (!this.timings || !this.container || this.mode === 'off' || !this.flat.length) return;
    const ms = this.currentMs;
    const idx = wordAtTime(this.flat, ms);
    if (idx === this.activeWord || idx < 0) return;
    const word = this.flat[idx];

    if (word.blockIndex !== this.activeBlockIndex) this.activateBlock(word.blockIndex);
    this.activeWord = idx;

    if (this.mode === 'word' && this.activeSpans.length) {
      this.container.querySelector('.ra-word.word-active')?.classList.remove('word-active');
      this.activeSpans[word.wordIndex]?.classList.add('word-active');
    }
  }

  private activateBlock(blockIndex: number): void {
    if (!this.timings || !this.content || !this.container) return;
    // Restore the previous block to plain text.
    if (this.activeBlockIndex >= 0) {
      const prevTiming = this.timings.blocks[this.activeBlockIndex];
      const prevEl = this.container.querySelector<HTMLElement>(`[data-block-id="${prevTiming.blockId}"]`);
      const prevBlock = this.content.blocks.find((b) => b.id === prevTiming.blockId);
      prevEl?.classList.remove('block-active');
      if (prevEl && prevBlock && prevBlock.type === 'paragraph') {
        unspanifyBlock(prevEl, prevBlock.text, prevBlock.spans);
      }
      this.activeSpans = [];
    }

    this.activeBlockIndex = blockIndex;
    const timing = this.timings.blocks[blockIndex];
    const el = this.container.querySelector<HTMLElement>(`[data-block-id="${timing.blockId}"]`);
    const block = this.content.blocks.find((b) => b.id === timing.blockId);
    if (!el || !block) return;

    el.classList.add('block-active');
    if (this.mode === 'word' && block.type === 'paragraph') {
      this.activeSpans = spanifyBlock(el, timing, block.text);
    }
    if (Date.now() - this.userScrolledAt > 5000) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  private clearHighlight(): void {
    if (this.container && this.timings && this.content && this.activeBlockIndex >= 0) {
      const timing = this.timings.blocks[this.activeBlockIndex];
      const el = this.container.querySelector<HTMLElement>(`[data-block-id="${timing.blockId}"]`);
      const block = this.content.blocks.find((b) => b.id === timing.blockId);
      el?.classList.remove('block-active');
      if (el && block?.type === 'paragraph') unspanifyBlock(el, block.text, block.spans);
    }
    this.activeSpans = [];
    this.activeWord = -1;
    this.activeBlockIndex = -1;
  }
}

export const audioController = new AudioController();
