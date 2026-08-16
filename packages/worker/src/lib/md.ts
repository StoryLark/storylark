/**
 * The StoryLark markdown → blocks machinery, Worker edition (AB#7420).
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 * The canonical implementation is `packages/pipeline/lib/md.mjs`. This is a
 * deliberate second implementation of the SAME rules, and the duplication is a
 * decision rather than an accident:
 *
 *   • The Worker cannot import the pipeline. `storylark-pipeline` depends on
 *     kokoro-js, @huggingface/transformers, sharp, the MS Speech SDK and
 *     @azure/storage-blob — hundreds of megabytes of Node-only code that has
 *     no business inside a Workers isolate.
 *   • The pipeline cannot import the Worker either: `storylark-pipeline` runs
 *     under plain `node`, so it cannot consume `.ts`, and inverting the
 *     dependency would make the publish CLI depend on the API server.
 *   • A third shared package would be correct in the abstract, but it is a NEW
 *     npm package that does not exist on the registry yet — and this repo has
 *     already been burned once by shipping a package that referenced something
 *     unpublished (create-storylark, 0.1.0).
 *
 * So instead of hoping the two stay in step, `packages/worker/test/md-parity.test.mjs`
 * asserts they produce byte-identical output over a corpus that exercises every
 * block type. If either side drifts, that test fails. That is the same
 * cross-implementation parity guard plan §1 calls for between the D1 and
 * Postgres drivers.
 *
 * ── What differs from md.mjs, and why ───────────────────────────────────────
 * `contentHash` and `stabilizeBlockIds` are async here. Node has a synchronous
 * `createHash`; the Web Crypto API a Worker gets does not. The digest is the
 * same SHA-256 over the same `JSON.stringify` input, so the hex output is
 * identical — only the call shape changed.
 */

import type { Block, StyleSpan } from '../content-types';
import { sha256Hex } from './crypto';

/** Minimal frontmatter reader — flat `key: value` pairs only (nested keys ignored). */
export function readFrontmatter(source: string): { data: Record<string, string | number | boolean>; body: string } {
  source = source.replace(/^﻿/, ''); // some source files carry a UTF-8 BOM
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const data: Record<string, string | number | boolean> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue; // skips nested mapping lines
    let value: string | number | boolean = kv[2].trim();
    if (value === '') continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^\d+$/.test(value as string)) value = Number(value);
    data[kv[1]] = value;
  }
  return { data, body: source.slice(match[0].length) };
}

/** Serialise frontmatter + body back to a markdown file. Inverse of readFrontmatter. */
export function writeFrontmatter(data: Record<string, string | number | boolean | undefined>, body: string): string {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return body;
  return `---\n${entries.map(([k, v]) => `${k}: ${String(v)}`).join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

const MESSAGE_RE = /^> \*\*(.+?) \((.+?)\):\*\* (.*)$/;
// A whole line that is nothing but a markdown image: ![alt](url). Anchored so
// inline images inside a prose line are left untouched (they stay in the text).
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

/**
 * Parses a markdown prose body into StoryLark blocks. Rules, byte-for-byte the
 * ones in `packages/pipeline/lib/md.mjs`:
 *   ---                       → scene-break
 *   > **Name (time):** text   → message-block (consecutive quotes merge)
 *   ![alt](url)               → image (standalone line only; never narrated)
 *   *End of X.*               → end-marker
 *   *whole-line italic*       → display-beat
 *   everything else           → paragraph with em/strong spans
 */
export function parseBlocks(body: string, { siteOrigin }: { siteOrigin?: string } = {}): Block[] {
  const paragraphs = body
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const blocks: Block[] = [];
  let n = 0;
  const nextId = (): string => `b${String(++n).padStart(3, '0')}`;

  const resolveSrc = (src: string): string => {
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith('/') && siteOrigin) return siteOrigin.replace(/\/+$/, '') + src;
    return src;
  };

  const emitProse = (single: string): void => {
    if (!single) return;
    if (/^\*End of .+\*$/.test(single)) {
      blocks.push({ id: nextId(), type: 'end-marker', text: single.slice(1, -1) });
      return;
    }
    if (/^\*[^*]+\*$/.test(single)) {
      blocks.push({ id: nextId(), type: 'display-beat', text: single.slice(1, -1) });
      return;
    }
    const { text, spans } = extractSpans(single);
    blocks.push(spans.length ? { id: nextId(), type: 'paragraph', text, spans } : { id: nextId(), type: 'paragraph', text });
  };

  for (const para of paragraphs) {
    if (/^-{3,}$/.test(para)) {
      blocks.push({ id: nextId(), type: 'scene-break' });
      continue;
    }

    if (MESSAGE_RE.test(para.split('\n')[0])) {
      const messages: { speaker: string; time: string; text: string }[] = [];
      for (const line of para.split('\n')) {
        const m = MESSAGE_RE.exec(line.trim());
        if (m) messages.push({ speaker: m[1], time: m[2], text: m[3] });
      }
      const prev = blocks[blocks.length - 1];
      if (prev?.type === 'message-block') prev.messages.push(...messages);
      else blocks.push({ id: nextId(), type: 'message-block', messages });
      continue;
    }

    const lines = para.split('\n');
    if (lines.some((l) => IMAGE_LINE_RE.test(l.trim()))) {
      let buffer: string[] = [];
      const flush = (): void => {
        if (buffer.length) emitProse(buffer.join(' ').trim());
        buffer = [];
      };
      for (const line of lines) {
        const m = IMAGE_LINE_RE.exec(line.trim());
        if (m) {
          flush();
          blocks.push({ id: nextId(), type: 'image', src: resolveSrc(m[2].trim()), alt: m[1].trim() });
        } else if (line.trim()) {
          buffer.push(line.trim());
        }
      }
      flush();
      continue;
    }

    emitProse(para.replace(/\n/g, ' '));
  }

  return blocks;
}

/** Strips **strong** and *em* markers, recording their plain-text offsets. */
export function extractSpans(md: string): { text: string; spans: StyleSpan[] } {
  const spans: StyleSpan[] = [];
  let text = '';
  let i = 0;
  while (i < md.length) {
    if (md.startsWith('**', i)) {
      const close = md.indexOf('**', i + 2);
      if (close > i + 2) {
        const start = text.length;
        const inner = stripEm(md.slice(i + 2, close), text.length, spans);
        text += inner;
        spans.push({ start, end: text.length, style: 'strong' });
        i = close + 2;
        continue;
      }
    }
    if (md[i] === '*' && md[i + 1] !== '*') {
      const close = md.indexOf('*', i + 1);
      if (close > i) {
        const start = text.length;
        text += md.slice(i + 1, close);
        spans.push({ start, end: text.length, style: 'em' });
        i = close + 1;
        continue;
      }
    }
    text += md[i++];
  }
  return { text, spans: spans.sort((a, b) => a.start - b.start) };
}

function stripEm(md: string, base: number, spans: StyleSpan[]): string {
  let out = '';
  let i = 0;
  while (i < md.length) {
    if (md[i] === '*') {
      const close = md.indexOf('*', i + 1);
      if (close > i) {
        spans.push({ start: base + out.length, end: base + out.length + (close - i - 1), style: 'em' });
        out += md.slice(i + 1, close);
        i = close + 1;
        continue;
      }
    }
    out += md[i++];
  }
  return out;
}

export function blockPlainText(block: Block): string {
  switch (block.type) {
    case 'paragraph':
    case 'display-beat':
    case 'end-marker':
      return block.text;
    case 'message-block':
      return block.messages.map((m) => `${m.speaker}, ${m.time}: ${m.text}`).join(' ');
    case 'image':
      return ''; // images are never narrated and never count toward TTS chars
    default:
      return '';
  }
}

export function chapterCharLength(blocks: Block[]): number {
  return blocks.reduce((sum, b) => sum + blockPlainText(b).length, 0);
}

export function countWords(blocks: Block[]): number {
  return blocks.reduce((sum, b) => sum + (blockPlainText(b).match(/\S+/g)?.length ?? 0), 0);
}

/**
 * SHA-256 of `JSON.stringify(obj)`, first 8 hex chars — identical output to the
 * pipeline's synchronous `contentHash`, which is what keeps a portal edit and a
 * CLI publish agreeing on whether a chapter changed.
 */
export async function contentHash(obj: unknown): Promise<string> {
  return (await sha256Hex(JSON.stringify(obj))).slice(0, 8);
}

/**
 * Keeps block IDs stable across republishes: any block whose text hash matches
 * a block from the previous publish keeps its old ID, so bookmarks and progress
 * survive an edit elsewhere in the chapter. This is what makes "fix a typo in
 * paragraph 3" not throw away every reader's place in the other 40 paragraphs.
 *
 * The two-pass structure and the reason ids MUST come out unique are documented
 * on the pipeline's copy (packages/pipeline/lib/md.mjs). Both are kept in step
 * by packages/worker/test/md-parity.test.mjs, which now asserts uniqueness
 * across the insert-at-the-top case that used to produce two `b001`s.
 */
export async function stabilizeBlockIds(blocks: Block[], previousBlocks?: Block[]): Promise<Block[]> {
  if (!previousBlocks?.length) return blocks;
  const prevByHash = new Map<string, string[]>();
  for (const p of previousBlocks) {
    const h = await contentHash({ t: p.type, x: blockPlainText(p) });
    if (!prevByHash.has(h)) prevByHash.set(h, []);
    prevByHash.get(h)!.push(p.id);
  }

  // Pass 1 — inherit, reserving every inherited id up front.
  const used = new Set<string>();
  const inherited: (string | null)[] = [];
  for (const b of blocks) {
    const h = await contentHash({ t: b.type, x: blockPlainText(b) });
    const id = (prevByHash.get(h) ?? []).find((c) => !used.has(c));
    if (id) used.add(id);
    inherited.push(id ?? null);
  }

  // Pass 2 — keep a parsed id when it is free, otherwise take the lowest bNNN
  // nobody is using.
  let counter = 0;
  const nextFreeId = (): string => {
    let id: string;
    do {
      id = `b${String(++counter).padStart(3, '0')}`;
    } while (used.has(id));
    used.add(id);
    return id;
  };
  return blocks.map((b, i) => {
    const id = inherited[i];
    if (id) return { ...b, id };
    if (!used.has(b.id)) {
      used.add(b.id);
      return b;
    }
    return { ...b, id: nextFreeId() };
  });
}

const WORDS_PER_MINUTE = 200;

/** Word count + reading time, the same derivation markdown-import.mjs applies. */
export function chapterMeta(blocks: Block[]): { charLength: number; wordCount: number; readingTime: string } {
  const wordCount = countWords(blocks);
  return {
    charLength: chapterCharLength(blocks),
    wordCount,
    readingTime: `${Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE))} min`,
  };
}
