// Shared markdown machinery for the publish pipeline: frontmatter reader +
// prose-convention block parser. The block conventions are the ones the
// publish pipeline (tools/publish.mjs) emits into chapter JSON.

import { createHash } from 'node:crypto';

/** Minimal frontmatter reader — flat `key: value` pairs only (nested keys ignored). */
export function readFrontmatter(source) {
  source = source.replace(/^﻿/, ''); // some source files carry a UTF-8 BOM
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue; // skips nested mapping lines (prev:/next: children)
    let value = kv[2].trim();
    if (value === '') continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^\d+$/.test(value)) value = Number(value);
    data[kv[1]] = value;
  }
  return { data, body: source.slice(match[0].length) };
}

const MESSAGE_RE = /^> \*\*(.+?) \((.+?)\):\*\* (.*)$/;
// A whole line that is nothing but a markdown image: ![alt](url). Anchored so
// inline images inside a prose line are left untouched (they stay in the text).
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

/**
 * Parses a markdown prose body into StoryLark blocks:
 *   ---                       → scene-break
 *   > **Name (time):** text   → message-block (consecutive quotes merge)
 *   ![alt](url)               → image (standalone line only; never narrated)
 *   *End of X.*               → end-marker
 *   *whole-line italic*       → display-beat
 *   everything else           → paragraph with em/strong spans
 *
 * `siteOrigin` (e.g. https://example.com) turns a root-relative image
 * `src` (`/images/...`) into an absolute URL on the brand's marketing site,
 * where the art actually serves — mirroring how coverImage paths resolve.
 */
export function parseBlocks(body, { siteOrigin } = {}) {
  const paragraphs = body
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const blocks = [];
  let n = 0;
  const nextId = () => `b${String(++n).padStart(3, '0')}`;

  // Root-relative → absolute on the marketing origin; http(s) URLs pass through.
  const resolveSrc = (src) => {
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith('/') && siteOrigin) return siteOrigin.replace(/\/+$/, '') + src;
    return src;
  };

  // Emits a prose paragraph — or an end-marker / display-beat when the whole
  // line is one of those italic conventions. Shared by the plain-paragraph path
  // and the prose segments that surround a standalone image line.
  const emitProse = (single) => {
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
      const messages = [];
      for (const line of para.split('\n')) {
        const m = MESSAGE_RE.exec(line.trim());
        if (m) messages.push({ speaker: m[1], time: m[2], text: m[3] });
      }
      // Merge into the previous message-block when they're adjacent paragraphs.
      const prev = blocks[blocks.length - 1];
      if (prev?.type === 'message-block') prev.messages.push(...messages);
      else blocks.push({ id: nextId(), type: 'message-block', messages });
      continue;
    }

    // Standalone image line(s). A paragraph may hold an image on its own line
    // (the common case) or prose lines flanking it; each image line becomes its
    // own image block, and each run of prose lines flushes as a paragraph.
    const lines = para.split('\n');
    if (lines.some((l) => IMAGE_LINE_RE.test(l.trim()))) {
      let buffer = [];
      const flush = () => {
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

  // A trailing scene-break immediately before the end-marker is decoration on
  // the page; keep it — the reader renders it as the site does.
  return blocks;
}

/** Strips **strong** and *em* markers, recording their plain-text offsets. */
export function extractSpans(md) {
  const spans = [];
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

function stripEm(md, base, spans) {
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

export function blockPlainText(block) {
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

export function chapterCharLength(blocks) {
  return blocks.reduce((sum, b) => sum + blockPlainText(b).length, 0);
}

export function contentHash(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 8);
}

export function countWords(blocks) {
  return blocks.reduce((sum, b) => sum + (blockPlainText(b).match(/\S+/g)?.length ?? 0), 0);
}

/**
 * Keeps block IDs stable across republishes: any block whose text hash matches
 * a block from the previous publish keeps its old ID, so bookmarks and
 * progress survive edits elsewhere in the chapter.
 *
 * ── Uniqueness is not optional (AB#7412) ────────────────────────────────────
 * Inheriting an id can COLLIDE with a freshly-parsed one. Insert a paragraph at
 * the top of a chapter: the new block parses as `b001` and keeps it (nothing
 * matches), while the old first paragraph — now parsed as `b002` — inherits
 * `b001`. Two blocks, one id.
 *
 * That was real and it broke three things at once: `stitch.mjs` keys word
 * timings by block id, so the second `b001` silently took the first's timings
 * and word-sync highlighting went wrong from there on; reader progress and
 * bookmarks address a block by id and would land on whichever came first; and
 * the chapter's content hash stopped being idempotent, so republishing an
 * unchanged file produced a different hash every time.
 *
 * The fix is one extra pass: inherit first, then give every block that
 * inherited nothing an id that is genuinely free. A chapter with no collisions
 * comes out byte-for-byte as before, so no existing content re-hashes.
 */
export function stabilizeBlockIds(blocks, previousBlocks) {
  if (!previousBlocks?.length) return blocks;
  const prevByHash = new Map();
  for (const p of previousBlocks) {
    const h = contentHash({ t: p.type, x: blockPlainText(p) });
    if (!prevByHash.has(h)) prevByHash.set(h, []);
    prevByHash.get(h).push(p.id);
  }

  // Pass 1 — inherit. Reserving every inherited id BEFORE any parsed id is
  // kept is what makes pass 2 able to tell "free" from "about to be taken".
  const used = new Set();
  const inherited = blocks.map((b) => {
    const h = contentHash({ t: b.type, x: blockPlainText(b) });
    const id = (prevByHash.get(h) ?? []).find((c) => !used.has(c));
    if (id) used.add(id);
    return id ?? null;
  });

  // Pass 2 — everything else keeps its parsed id when that id is still free,
  // and otherwise takes the lowest bNNN nobody is using.
  let counter = 0;
  const nextFreeId = () => {
    let id;
    do {
      id = `b${String(++counter).padStart(3, '0')}`;
    } while (used.has(id));
    used.add(id);
    return id;
  };
  return blocks.map((b, i) => {
    if (inherited[i]) return { ...b, id: inherited[i] };
    if (!used.has(b.id)) {
      used.add(b.id);
      return b;
    }
    return { ...b, id: nextFreeId() };
  });
}
