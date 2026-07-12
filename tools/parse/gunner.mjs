// Gunner the Lab parser: 42 standalone stories in the site repo at
// src/content/stories/*.md. Each story becomes a one-chapter book, grouped
// in the Library by its era label.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readFrontmatter, parseBlocks, chapterCharLength, countWords, stabilizeBlockIds } from '../lib/md.mjs';

const AUTHOR = 'Gunner the Lab';

export async function parseGunner(sourceRepo, previousChapters = {}, siteOrigin) {
  const dir = join(sourceRepo, 'src', 'content', 'stories');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));

  const books = [];
  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8');
    const { data, body } = readFrontmatter(raw);
    if (data.draft === true || !data.title) continue;
    const id = file.replace(/\.md$/, '');
    let blocks = parseBlocks(body, { siteOrigin });
    blocks = stabilizeBlockIds(blocks, previousChapters[`${id}/story`]?.blocks);
    books.push({
      book: {
        id,
        title: data.title,
        author: AUTHOR,
        group: data.eraLabel ?? data.era ?? '',
        description: data.description,
        coverSource: data.coverImage, // absolute /images/... path in the site repo
        order: data.order ?? data.storyNumber ?? 999,
        publishDate: normalizeDate(data.publishDate),
        timeframe: data.timeframe ? String(data.timeframe) : undefined, // in-world "YYYY-MM" for chronological sort
      },
      chapter: {
        id: 'story',
        bookId: id,
        title: data.title,
        blocks,
        charLength: chapterCharLength(blocks),
        wordCount: countWords(blocks),
      },
    });
  }

  books.sort((a, b) => a.book.order - b.book.order || String(a.book.id).localeCompare(String(b.book.id)));
  return books;
}

/** Frontmatter dates may parse as Date objects or strings — emit ISO yyyy-mm-dd. */
function normalizeDate(v) {
  if (!v) return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}
