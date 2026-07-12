// Holdfast Press parser: published chapters live in the site repo at
// src/pages/the-keepers/*.md (the full manuscript stays private).

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readFrontmatter, parseBlocks, chapterCharLength, countWords, stabilizeBlockIds } from '../lib/md.mjs';

const BOOK_ID = 'the-keepers';
const BOOK_TITLE = 'The Keepers: What the Stones Remember';
const AUTHOR = 'R.J. Thornton';
const SERIES = 'The Keepers';
const SERIES_ORDER = 1; // series shelf order in the Library
const BOOK_ORDER = 1; // Book One

// Reading order — frontmatter has prev/next links but flat parsing is simpler
// and the list only grows when a new chapter publishes.
const ORDER = ['prologue', 'chapter-one', 'chapter-two', 'chapter-three', 'chapter-four', 'chapter-five'];

export async function parseHoldfast(sourceRepo, previousChapters = {}, siteOrigin) {
  const dir = join(sourceRepo, 'src', 'pages', 'the-keepers');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md') && f !== 'index.md');

  const chapters = [];
  for (const file of files) {
    const id = file.replace(/\.md$/, '');
    const raw = await readFile(join(dir, file), 'utf8');
    const { data, body } = readFrontmatter(raw);
    if (!data.title || !data.chapterLabel) continue; // landing/other pages
    let blocks = parseBlocks(body, { siteOrigin });
    blocks = stabilizeBlockIds(blocks, previousChapters[id]?.blocks);
    chapters.push({
      id,
      bookId: BOOK_ID,
      title: data.title,
      label: data.chapterLabel,
      setting: data.setting,
      readingTime: data.readingTime,
      blocks,
      charLength: chapterCharLength(blocks),
      wordCount: countWords(blocks),
    });
  }

  chapters.sort((a, b) => orderOf(a.id) - orderOf(b.id));
  return {
    book: {
      id: BOOK_ID,
      title: BOOK_TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesOrder: SERIES_ORDER,
      order: BOOK_ORDER,
    },
    chapters,
  };
}

function orderOf(id) {
  const i = ORDER.indexOf(id);
  return i === -1 ? 999 : i;
}
