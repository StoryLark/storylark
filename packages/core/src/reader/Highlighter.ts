import type { BlockTiming, ChapterTimings } from '../lib/types';

export interface FlatWord {
  blockIndex: number;
  wordIndex: number;
  charStart: number;
  charEnd: number;
  startMs: number;
  endMs: number;
}

/** Flattens the per-block word timings into one globally ordered array for binary search. */
export function flattenTimings(timings: ChapterTimings): FlatWord[] {
  const flat: FlatWord[] = [];
  timings.blocks.forEach((block, blockIndex) => {
    block.words.forEach(([charStart, charEnd, startMs, endMs], wordIndex) => {
      flat.push({ blockIndex, wordIndex, charStart, charEnd, startMs, endMs });
    });
  });
  flat.sort((a, b) => a.startMs - b.startMs);
  return flat;
}

export function wordAtTime(flat: FlatWord[], ms: number): number {
  // Index of the last word whose startMs <= ms.
  let lo = 0;
  let hi = flat.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flat[mid].startMs <= ms) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function blockAtTime(timings: ChapterTimings, ms: number): number {
  let lo = 0;
  let hi = timings.blocks.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timings.blocks[mid].startMs <= ms) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Wraps a block element's text in word spans according to its timing entry.
 * Only the active block is ever spanned — the rest of the chapter stays as
 * plain text nodes so the DOM remains small.
 */
export function spanifyBlock(el: HTMLElement, timing: BlockTiming, text: string): HTMLElement[] {
  const frag = document.createDocumentFragment();
  const spans: HTMLElement[] = [];
  let cursor = 0;
  timing.words.forEach(([charStart, charEnd], i) => {
    if (charStart > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, charStart)));
    const span = document.createElement('span');
    span.className = 'ra-word';
    span.dataset.w = String(i);
    span.textContent = text.slice(charStart, charEnd);
    frag.appendChild(span);
    spans.push(span);
    cursor = charEnd;
  });
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  el.textContent = '';
  el.appendChild(frag);
  return spans;
}

/** Restores a spanned block, re-applying its em/strong style spans. */
export function unspanifyBlock(el: HTMLElement, text: string, spans?: { start: number; end: number; style: 'em' | 'strong' }[]): void {
  if (!spans?.length) {
    el.textContent = text;
    return;
  }
  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, s.start)));
    const inner = document.createElement(s.style === 'strong' ? 'strong' : 'em');
    inner.textContent = text.slice(s.start, s.end);
    frag.appendChild(inner);
    cursor = s.end;
  }
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  el.textContent = '';
  el.appendChild(frag);
}
