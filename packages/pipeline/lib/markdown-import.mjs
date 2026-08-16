// The blessed StoryLark story format (AB#7401): plain markdown, no custom
// parser required. publish.mjs uses this automatically when --parser is
// omitted.
//
// Convention, under <source>/books/:
//   <book-id>/book.json        optional — { title, author, description,
//                                            order, coverSource }
//   <book-id>/NN-<slug>.md     one file per chapter, ordered by filename;
//                              chapterId defaults to <slug>, override with
//                              frontmatter `chapterId`. Frontmatter may set
//                              `title` and `label` per chapter.
//   <book-id>.md               shorthand for a single-chapter book — the
//                              whole file is chapterId "full"; its
//                              frontmatter doubles as book metadata (title,
//                              author, description, order, coverSource).
//
// Built on the same shared helpers examples/demo/parser.mjs already used —
// this is that parser generalized to multiple chapters per book and no
// longer site-owned.
import { readdir, readFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { readFrontmatter, parseBlocks, chapterCharLength, countWords, stabilizeBlockIds } from './md.mjs';

const WORDS_PER_MINUTE = 200;

function chapterMeta(blocks) {
  const wordCount = countWords(blocks);
  return {
    charLength: chapterCharLength(blocks),
    wordCount,
    readingTime: `${Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE))} min`,
  };
}

async function parseChapterFile(path, previous, siteOrigin, chapterId, defaultLabel) {
  const raw = await readFile(path, 'utf8');
  const { data, body } = readFrontmatter(raw);
  const blocks = stabilizeBlockIds(parseBlocks(body, { siteOrigin }), previous?.blocks);
  return {
    id: data.chapterId ?? chapterId,
    title: data.title,
    label: data.label ?? defaultLabel,
    blocks,
    // The file exactly as authored (AB#7420 — plan §3). publish.mjs uploads it
    // to books/<book>/source/<chapter>.md so the DEPLOYMENT holds the editable
    // source of truth, which is the whole blocker under portal editing: until
    // now the markdown never left the operator's laptop, so there was nothing
    // for a browser to open and fix. A custom --parser that has no markdown to
    // give simply omits this, and publish.mjs uploads no source for it.
    source: raw,
    ...chapterMeta(blocks),
  };
}

/** Chapter id from a filename like "02-the-second-chapter.md" -> "the-second-chapter". */
function slugFromFilename(file) {
  return basename(file, extname(file)).replace(/^\d+[-_.]?/, '') || basename(file, extname(file));
}

async function parseBookFolder(dir, bookId, previous, siteOrigin) {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  if (entries.length === 0) throw new Error(`Book folder "${bookId}" has no chapter .md files.`);

  let meta = {};
  try {
    meta = JSON.parse(await readFile(join(dir, 'book.json'), 'utf8'));
  } catch {
    // book.json is optional — fall back to the first chapter's frontmatter below.
  }

  const chapters = [];
  for (const file of entries) {
    const chapterId = slugFromFilename(file);
    const key = `${bookId}/${chapterId}`;
    chapters.push(await parseChapterFile(join(dir, file), previous[key], siteOrigin, chapterId, 'Chapter'));
  }

  if (!meta.title) {
    const { data } = readFrontmatter(await readFile(join(dir, entries[0]), 'utf8'));
    meta = { title: data.title, author: data.author, description: data.description, order: data.order, coverSource: data.coverSource, ...meta };
  }

  return {
    book: { id: bookId, title: meta.title, author: meta.author, description: meta.description, order: meta.order, coverSource: meta.coverSource },
    chapters,
  };
}

async function parseSingleFileBook(path, bookId, previous, siteOrigin) {
  const raw = await readFile(path, 'utf8');
  const { data, body } = readFrontmatter(raw);
  const chapterId = data.chapterId ?? 'full';
  const blocks = stabilizeBlockIds(parseBlocks(body, { siteOrigin }), previous[`${bookId}/${chapterId}`]?.blocks);
  return {
    book: { id: data.bookId ?? bookId, title: data.title, author: data.author, description: data.description, order: data.order, coverSource: data.coverSource },
    chapters: [{ id: chapterId, title: data.title, label: data.label ?? 'Read', blocks, source: raw, ...chapterMeta(blocks) }],
  };
}

export async function parse(sourceRepo, previous = {}, siteOrigin) {
  const booksDir = join(sourceRepo, 'books');
  const entries = await readdir(booksDir, { withFileTypes: true });

  const books = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      books.push(await parseBookFolder(join(booksDir, entry.name), entry.name, previous, siteOrigin));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      books.push(await parseSingleFileBook(join(booksDir, entry.name), basename(entry.name, '.md'), previous, siteOrigin));
    }
  }

  return { books };
}

export default parse;
