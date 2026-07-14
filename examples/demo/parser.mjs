// Demo content parser for the StoryLark publish pipeline.
//
// The pipeline is brand-neutral; each site owns its own parser and injects it
// with --parser (see packages/pipeline/publish.mjs). This one reads the plain-markdown
// public-domain stories under examples/demo/books/ — one file per story, each
// story a single "full" chapter — and turns them into the pipeline's canonical
// { books: [{ book, chapters }] } shape using the shared markdown helpers.
//
//   node packages/pipeline/publish.mjs --brand storylark \
//     --source examples/demo --parser examples/demo/parser.mjs --no-audio --local app/dist

import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  readFrontmatter,
  parseBlocks,
  chapterCharLength,
  countWords,
  stabilizeBlockIds,
} from 'storylark-pipeline/md';

const WORDS_PER_MINUTE = 200;

/**
 * @param sourceRepo   path passed to --source (this directory's parent layout)
 * @param previous     state.chapters from the last publish, keyed "bookId/chapterId"
 * @param siteOrigin   marketing origin for resolving root-relative image srcs
 */
export async function parse(sourceRepo, previous = {}, siteOrigin) {
  const booksDir = join(sourceRepo, 'books');
  const files = (await readdir(booksDir)).filter((f) => f.endsWith('.md')).sort();

  const books = [];
  for (const file of files) {
    const { data, body } = readFrontmatter(await readFile(join(booksDir, file), 'utf8'));
    const bookId = data.bookId ?? basename(file, '.md');
    const chapterId = data.chapterId ?? 'full';

    let blocks = parseBlocks(body, { siteOrigin });
    // Keep block IDs stable across republishes so bookmarks/progress survive edits.
    blocks = stabilizeBlockIds(blocks, previous[`${bookId}/${chapterId}`]?.blocks);

    const wordCount = countWords(blocks);
    books.push({
      book: {
        id: bookId,
        title: data.title,
        author: data.author,
        description: data.description,
        order: data.order,
      },
      chapters: [
        {
          id: chapterId,
          title: data.title,
          label: data.label ?? 'Read',
          blocks,
          charLength: chapterCharLength(blocks),
          wordCount,
          readingTime: `${Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE))} min`,
        },
      ],
    });
  }

  return { books };
}

export default parse;
