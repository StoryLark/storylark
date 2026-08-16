// The guard that makes the duplicated markdown machinery safe (AB#7420).
//
// `packages/pipeline/lib/md.mjs` and `packages/worker/src/lib/md.ts` implement
// the same rules for two runtimes that cannot import each other (see the long
// note at the top of md.ts for why). This asserts they agree — block for block,
// span for span, hash for hash — over a corpus that exercises every block type
// plus the real example books in this repo.
//
// If it fails, one of the two has drifted, and a chapter edited in the admin
// portal would publish differently from the same chapter published by the CLI.
//
//   node --test packages/worker/test/md-parity.test.mjs
//
// Runs on Node's own test runner with no new dependency; the .ts side is loaded
// through Node's built-in type stripping (Node >= 22.6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as node from '../../pipeline/lib/md.mjs';
import * as worker from '../src/lib/md.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

const CORPUS = [
  ['empty', ''],
  ['plain paragraph', 'Just one plain paragraph.'],
  ['two paragraphs', 'First paragraph.\n\nSecond paragraph.'],
  ['soft-wrapped paragraph', 'A line\nand its continuation\nand a third.'],
  ['scene break', 'Before.\n\n---\n\nAfter.'],
  ['long scene break', 'Before.\n\n-----\n\nAfter.'],
  ['display beat', '*She waited.*'],
  ['end marker', '*End of Chapter One.*'],
  ['strong span', 'He said **absolutely not** and left.'],
  ['em span', 'He said *nothing* at all.'],
  ['nested em inside strong', 'A **bold with *italic* inside** end.'],
  ['multiple spans', '**One** plain *two* plain **three**.'],
  ['unclosed strong', 'A dangling ** marker stays put.'],
  ['message block', '> **Ada (09:14):** Are you there?\n> **Bob (09:15):** Always.'],
  ['adjacent message blocks', '> **Ada (09:14):** One.\n\n> **Bob (09:15):** Two.'],
  ['standalone image', '![A lighthouse at dusk](/images/lighthouse.jpg)'],
  ['image with absolute url', '![Cover](https://cdn.example.com/a.png)'],
  ['image with empty alt', '![](/images/x.png)'],
  ['image between prose lines', 'Above the art.\n![Alt text](/images/mid.png)\nBelow the art.'],
  ['two images in one paragraph', '![One](/images/1.png)\n![Two](/images/2.png)'],
  ['inline image stays prose', 'Look at ![this](/images/inline.png) here.'],
  ['frontmatter only', '---\ntitle: A Title\nlabel: Read\n---\n'],
  ['frontmatter and body', '---\ntitle: A Title\nauthor: Someone\norder: 3\ndraft: false\n---\n\nThe body starts here.'],
  ['quoted frontmatter values', '---\ntitle: "Quoted: Title"\nlabel: \'Read\'\n---\n\nBody.'],
  ['BOM', '﻿---\ntitle: With BOM\n---\n\nBody.'],
  ['CRLF everywhere', '---\r\ntitle: CRLF\r\n---\r\n\r\nFirst.\r\n\r\nSecond.'],
  ['everything at once',
    '---\ntitle: The Long Dark\nlabel: Chapter\n---\n\n' +
    'Opening **paragraph** with *emphasis*.\n\n' +
    '---\n\n' +
    '![The door](/images/door.jpg)\n\n' +
    '> **Ada (23:59):** Still up?\n\n' +
    '*A pause.*\n\n' +
    '*End of The Long Dark.*'],
];

/** Every .md file the repo actually ships, so the corpus includes real prose. */
async function realBooks() {
  const out = [];
  const root = join(REPO, 'examples', 'demo', 'books');
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const f of (await readdir(join(root, entry.name))).filter((f) => f.endsWith('.md'))) {
        out.push([`${entry.name}/${f}`, await readFile(join(root, entry.name, f), 'utf8')]);
      }
    } else if (entry.name.endsWith('.md')) {
      out.push([entry.name, await readFile(join(root, entry.name), 'utf8')]);
    }
  }
  return out;
}

const SITE_ORIGIN = 'https://example.com';

test('readFrontmatter agrees', async () => {
  for (const [name, src] of [...CORPUS, ...(await realBooks())]) {
    assert.deepEqual(worker.readFrontmatter(src), node.readFrontmatter(src), name);
  }
});

test('parseBlocks agrees, with and without a site origin', async () => {
  for (const [name, src] of [...CORPUS, ...(await realBooks())]) {
    const { body } = node.readFrontmatter(src);
    assert.deepEqual(worker.parseBlocks(body), node.parseBlocks(body), `${name} (no origin)`);
    assert.deepEqual(
      worker.parseBlocks(body, { siteOrigin: SITE_ORIGIN }),
      node.parseBlocks(body, { siteOrigin: SITE_ORIGIN }),
      `${name} (with origin)`
    );
  }
});

test('extractSpans agrees', () => {
  for (const [name, src] of CORPUS) {
    assert.deepEqual(worker.extractSpans(src), node.extractSpans(src), name);
  }
});

test('word count, char length and reading time agree', async () => {
  for (const [name, src] of [...CORPUS, ...(await realBooks())]) {
    const blocks = node.parseBlocks(node.readFrontmatter(src).body);
    assert.equal(worker.countWords(blocks), node.countWords(blocks), `${name} words`);
    assert.equal(worker.chapterCharLength(blocks), node.chapterCharLength(blocks), `${name} chars`);
  }
});

test('contentHash agrees — this is what decides whether a chapter changed', async () => {
  for (const [name, src] of [...CORPUS, ...(await realBooks())]) {
    const blocks = node.parseBlocks(node.readFrontmatter(src).body);
    const title = node.readFrontmatter(src).data.title;
    assert.equal(await worker.contentHash({ blocks, title }), node.contentHash({ blocks, title }), name);
    assert.equal(await worker.contentHash({ blocks }), node.contentHash({ blocks }), `${name} (no title)`);
  }
});

test('stabilizeBlockIds agrees — reader bookmarks depend on it', async () => {
  const before = node.parseBlocks(
    'Alpha paragraph.\n\nBravo paragraph.\n\nCharlie paragraph.\n\n![Art](/images/a.png)\n\n*End of One.*'
  );
  // The realistic edit: one paragraph reworded, one inserted, the rest untouched.
  const after = node.parseBlocks(
    'Alpha paragraph.\n\nInserted paragraph.\n\nBravo paragraph, reworded.\n\nCharlie paragraph.\n\n![Art](/images/a.png)\n\n*End of One.*'
  );
  assert.deepEqual(await worker.stabilizeBlockIds(after, before), node.stabilizeBlockIds(after, before));
  assert.deepEqual(await worker.stabilizeBlockIds(after, undefined), node.stabilizeBlockIds(after, undefined));
  assert.deepEqual(await worker.stabilizeBlockIds(after, []), node.stabilizeBlockIds(after, []));
});

/**
 * The bug per-block re-narration surfaced (AB#7412).
 *
 * Insert a paragraph at the TOP of a chapter and, before the fix, two blocks
 * came back carrying `b001`: the new one kept its freshly-parsed id while the
 * old first paragraph inherited the same id from the previous publish. That
 * broke three things at once — `stitch.mjs` keys word timings by block id, so
 * the second `b001` silently took the first's timings; reader progress and
 * bookmarks address a block by id; and the chapter's content hash stopped being
 * idempotent, so republishing an unchanged file produced a new hash every time
 * (which in turn makes conflict detection fire on a publish that changed
 * nothing).
 *
 * Asserted on BOTH implementations, because a portal edit and a CLI publish
 * both go through this and both would corrupt the same ids.
 */
test('stabilizeBlockIds never emits a duplicate id, and is idempotent', async () => {
  const cases = [
    ['insert at the top', 'Alpha.\n\nBravo.\n\nCharlie.', 'Zulu.\n\nAlpha.\n\nBravo.\n\nCharlie.'],
    ['insert two at the top', 'Alpha.\n\nBravo.', 'Yankee.\n\nZulu.\n\nAlpha.\n\nBravo.'],
    ['move the last paragraph first', 'Alpha.\n\nBravo.\n\nCharlie.', 'Charlie.\n\nAlpha.\n\nBravo.'],
    ['reverse everything', 'Alpha.\n\nBravo.\n\nCharlie.', 'Charlie.\n\nBravo.\n\nAlpha.'],
    ['insert amid images and beats', 'Alpha.\n\n![Art](/i/a.png)\n\n*End of One.*', 'New opening.\n\nAlpha.\n\n![Art](/i/a.png)\n\n*End of One.*'],
  ];

  for (const [name, beforeSrc, afterSrc] of cases) {
    const before = node.parseBlocks(beforeSrc);
    const after = node.parseBlocks(afterSrc);

    for (const [impl, run] of [
      ['pipeline', (b, p) => node.stabilizeBlockIds(b, p)],
      ['worker', (b, p) => worker.stabilizeBlockIds(b, p)],
    ]) {
      const once = await run(after, before);
      const ids = once.map((b) => b.id);
      assert.equal(new Set(ids).size, ids.length, `${name} (${impl}): duplicate block id in ${ids.join(', ')}`);

      // Idempotent: stabilizing the same text against its own output must not
      // move a single id, or every republish looks like a change.
      const twice = await run(node.parseBlocks(afterSrc), once);
      assert.deepEqual(
        twice.map((b) => b.id),
        ids,
        `${name} (${impl}): a second pass moved the ids`
      );
      assert.equal(node.contentHash({ blocks: twice }), node.contentHash({ blocks: once }), `${name} (${impl}): hash is not idempotent`);
    }

    // …and the two implementations still agree, which is this file's whole job.
    assert.deepEqual(await worker.stabilizeBlockIds(after, before), node.stabilizeBlockIds(after, before), name);
  }
});

test('stabilizeBlockIds still preserves ids for an in-place edit — no content re-hashes for free', async () => {
  // The guard on the fix itself: a chapter with no id collision must come out
  // exactly as it did before the two-pass change, or every existing chapter in
  // every deployment would re-hash and re-narrate on the next publish.
  const before = node.parseBlocks('Alpha.\n\nBravo.\n\nCharlie.');
  const after = node.parseBlocks('Alpha.\n\nBravo, reworded.\n\nCharlie.');
  const out = node.stabilizeBlockIds(after, before);
  assert.deepEqual(
    out.map((b) => b.id),
    ['b001', 'b002', 'b003']
  );
  assert.deepEqual(await worker.stabilizeBlockIds(after, before), out);
});

test('chapterMeta matches what markdown-import.mjs derives', async () => {
  // markdown-import.mjs owns this derivation on the CLI side; the Worker needs
  // the same numbers or an edited chapter's reading time would jump on save.
  const src = (await realBooks())[0][1];
  const blocks = node.parseBlocks(node.readFrontmatter(src).body);
  const meta = worker.chapterMeta(blocks);
  const words = node.countWords(blocks);
  assert.equal(meta.wordCount, words);
  assert.equal(meta.charLength, node.chapterCharLength(blocks));
  assert.equal(meta.readingTime, `${Math.max(1, Math.round(words / 200))} min`);
});
