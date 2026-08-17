// A thin folder-walking wrapper around the pure content contract
// (`storylark-contracts/content`) — built for D5 "conformance tooling"
// (AB#7474, the last piece of the content-standards plan; see
// storylark-ops/pmo/scf-v1.md and docs/authoring-stories.md).
//
// content.mjs is deliberately platform-neutral — it also runs inside a
// Cloudflare Worker (packages/worker/src/lib/repo-sync.ts) — so it never
// touches the filesystem. This module is the one place that walks a
// directory tree and turns files into candidates, exactly the job
// repo-sync.ts does for a fetched archive. The pass/fail decision for every
// file still comes from `validateChapterCandidate` / `validateBookCandidate`
// — nothing here re-derives, approximates or duplicates a verdict.
//
// Mirrors repo-sync.ts's own walk deliberately, so a folder validated here
// and the same folder pushed through the repo transport agree file for file:
//   • a `.md` file with no `storylark:` block is not StoryLark content —
//     silently skipped, never an error (the opt-in rule, §2 of scf-v1.md).
//   • `requireBlock: true` — the strict repo rule — same as repo-sync.ts.
//   • a `type: story` file may leave its ids to the transport; here the
//     transport's address is the filename, exactly as repo-sync.ts uses the
//     archive entry's filename.
//   • chapters are grouped by book and re-checked with `validateBookCandidate`
//     for order ties, and a chapter naming a book nothing in the folder
//     declares is `unknown_book` — the same two cross-file rules repo-sync.ts
//     enforces. (`book_owned_elsewhere` needs a live deployment's manifest and
//     has no meaning against a bare folder, so it is not checked here.)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { isRepoCandidate, readStorylarkBlock, unknownBookError, validateBookCandidate, validateChapterCandidate } from './content.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Recursively list every `.md` file under `root`, in a deterministic (sorted) order. */
function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(root, full, out);
    } else if (st.isFile() && extname(name).toLowerCase() === '.md') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Validate every markdown file under `rootDir` through the exact same gate
 * the repo transport enforces.
 *
 * Returns `{ checked, ignored, candidates, errors }`:
 *   checked     every `.md` file found
 *   ignored     files with no `storylark:` block — not StoryLark content,
 *               correctly skipped, never an error
 *   candidates  files that carried a block and were judged
 *   errors      the gate's rejections, verbatim — the same `code`, `message`
 *               and `field` a live transport would produce for the same
 *               input, each carrying `file` relative to `rootDir` (forward
 *               slashes, whichever OS this runs on)
 */
export function validateContentFolder(rootDir) {
  const files = walk(rootDir);
  const errors = [];
  let ignored = 0;
  const candidates = []; // { file, markdown, record }
  const declaredBooks = new Set(); // book ids a `type: book` or `type: story` file in this folder declares

  for (const abs of files) {
    const file = relative(rootDir, abs).split('\\').join('/');
    const markdown = readFileSync(abs, 'utf8');

    if (!isRepoCandidate(markdown)) {
      ignored++;
      continue;
    }

    const block = readStorylarkBlock(markdown, { file });
    // A `type: story` file may leave its ids to the transport — the filename
    // is this transport's address for it, the same way repo-sync.ts uses the
    // archive entry's filename. A chapter or book file must state its own
    // identity; handing it one here would hide a genuinely missing field.
    const isStory = block.fields.type === 'story';
    const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    const candidate = {
      file,
      markdown,
      ...(isStory ? { bookId: typeof block.fields.book === 'string' ? block.fields.book : base, chapterId: 'full' } : {}),
    };

    const verdict = validateChapterCandidate(candidate, { requireBlock: true });
    if (!verdict.ok) {
      errors.push(...verdict.errors);
      continue;
    }
    if (verdict.record.type === 'book' || verdict.record.type === 'story') {
      declaredBooks.add(verdict.record.book);
    }
    candidates.push({ file, markdown, record: verdict.record });
  }

  // Group the folder as a SET (scf-v1.md §5 / §10.7 of the design), the same
  // way repo-sync.ts does: a chapter naming a book nothing here declares is
  // `unknown_book`, and two chapters of the same book claiming one `order` is
  // `order_tie` — both are between-file rules, so they only exist at this
  // level, never inside `validateChapterCandidate` itself.
  const chapterGroups = new Map();
  for (const c of candidates) {
    if (c.record.type !== 'chapter') continue;
    const bookId = c.record.book;
    if (!chapterGroups.has(bookId)) chapterGroups.set(bookId, []);
    chapterGroups.get(bookId).push(c);
  }

  for (const [bookId, group] of chapterGroups) {
    if (!declaredBooks.has(bookId)) {
      for (const c of group) errors.push(unknownBookError(bookId, { file: c.file }));
      continue;
    }
    const gate = validateBookCandidate(
      { bookId, chapters: group.map((c) => ({ file: c.file, markdown: c.markdown })) },
      { requireBlock: true }
    );
    for (const e of gate.errors) if (e.code === 'order_tie') errors.push(e);
  }

  return { checked: files.length, ignored, candidates: candidates.length, errors };
}
