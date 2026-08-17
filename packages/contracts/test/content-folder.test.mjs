// The `storylark-validate-content` CLI and its folder-walking wrapper — D5
// "conformance tooling" (AB#7474, the last piece of the content-standards
// plan). What is proven here, in increasing order of realness:
//
//   1. `validateContentFolder` calls the REAL gate: a clean folder passes
//      silently, a malformed `storylark:` block reports the exact code and
//      message `validateChapterCandidate` itself would give for the same
//      input, and files with no block are correctly treated as not
//      StoryLark content — never an error.
//   2. Cross-file rules that only exist between files — order ties,
//      `unknown_book` — are enforced too, the same way repo-sync.ts enforces
//      them, using the same exported helpers.
//   3. The actual CLI binary, spawned as a real subprocess against a real
//      temp folder on disk: correct stdout/stderr, correct exit code.
//
//   node --import tsx/esm --test packages/contracts/test/content-folder.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { validateContentFolder } from '../content-folder.mjs';
import { validateChapterCandidate } from '../content.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/validate-content.mjs', import.meta.url));

const PROSE = 'A paragraph of perfectly ordinary prose, long enough to be a chapter.';

/** A chapter file carrying a `storylark:` block, plus the customer's own untouched fields. */
function withBlock(fields, body = PROSE) {
  const block = Object.entries(fields)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  return `---\ntitle: Their Own Title\nstoryNumber: 7\nstorylark:\n${block}\n---\n${body ? `\n${body}\n` : ''}`;
}

async function tempFolder() {
  const dir = await mkdtemp(join(tmpdir(), 'storylark-validate-content-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. validateContentFolder calls the real gate
 * ──────────────────────────────────────────────────────────────────────────── */

test('a clean folder passes silently', async (t) => {
  const { dir, cleanup } = await tempFolder();
  t.after(cleanup);

  await mkdir(join(dir, 'the-keepers'), { recursive: true });
  await writeFile(
    join(dir, 'the-keepers', 'zz-book.md'),
    `---\ntitle: The Keepers\nauthor: A. Writer\nstorylark:\n  type: book\n  book: the-keepers\n---\n`
  );
  await writeFile(
    join(dir, 'the-keepers', '01-the-long-road.md'),
    withBlock({ type: 'chapter', book: 'the-keepers', chapter: 'the-long-road', order: 1 })
  );
  await writeFile(
    join(dir, 'the-keepers', '02-the-keeper.md'),
    withBlock({ type: 'chapter', book: 'the-keepers', chapter: 'the-keeper', order: 2 })
  );
  await writeFile(join(dir, 'README.md'), '# Just notes\n\nNot StoryLark content — no block.\n');

  const result = validateContentFolder(dir);
  assert.deepEqual(result.errors, [], 'a clean folder has no errors at all');
  assert.equal(result.checked, 4, 'every .md file is walked');
  assert.equal(result.ignored, 1, 'the block-less README is ignored, not an error');
  assert.equal(result.candidates, 3, 'the book file and both chapters were judged');
});

test('a malformed storylark: block reports the exact code, message and field a live transport would give', async (t) => {
  const { dir, cleanup } = await tempFolder();
  t.after(cleanup);

  const markdown = withBlock({ type: 'chapter', book: 'a-book', chapter: 'one', order: 'two' }); // invalid_order
  await writeFile(join(dir, 'one.md'), markdown);

  const result = validateContentFolder(dir);
  assert.equal(result.errors.length, 1);
  assert.equal(result.candidates, 0, 'the failing file is not counted as a passing candidate');

  // The SAME input, run straight through the gate the live transports call,
  // with the SAME file location the folder walk would supply.
  const direct = validateChapterCandidate({ file: 'one.md', markdown }, { requireBlock: true });
  assert.equal(direct.ok, false);
  assert.deepEqual(result.errors, direct.errors, 'byte-identical to what any transport would report');
  assert.equal(result.errors[0].code, 'invalid_order');
  assert.equal(result.errors[0].field, 'order');
  assert.equal(result.errors[0].file, 'one.md');
});

test('files with no storylark: block are treated as not-StoryLark-content, not an error', async (t) => {
  const { dir, cleanup } = await tempFolder();
  t.after(cleanup);

  await writeFile(join(dir, 'a-draft.md'), '# A draft\n\nJust thinking out loud.\n');
  await writeFile(join(dir, 'ordinary-frontmatter.md'), '---\ntitle: Their Own Site Page\ndraft: false\n---\n\nPlain prose, no block at all.\n');
  await mkdir(join(dir, 'notes'), { recursive: true });
  await writeFile(join(dir, 'notes', 'todo.md'), 'Nothing here says storylark either.\n');

  const result = validateContentFolder(dir);
  assert.equal(result.checked, 3);
  assert.equal(result.ignored, 3, 'none of these are StoryLark content');
  assert.equal(result.candidates, 0);
  assert.deepEqual(result.errors, [], 'silence, not a rejection');
});

test('the honest edge: broken front matter that mentions storylark: is a broken candidate, not a bystander', async (t) => {
  const { dir, cleanup } = await tempFolder();
  t.after(cleanup);
  await writeFile(join(dir, 'broken.md'), '---\nstorylark:\n  type: chapter\n\nNo closing fence at all.\n');

  const result = validateContentFolder(dir);
  assert.equal(result.candidates, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'unclosed_frontmatter');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Cross-file rules — order ties, unknown_book
 * ──────────────────────────────────────────────────────────────────────────── */

test('two chapters of the same book claiming one order is order_tie, across files', async (t) => {
  const { dir, cleanup } = await tempFolder();
  t.after(cleanup);

  await writeFile(join(dir, 'one.md'), withBlock({ type: 'chapter', book: 'a-book', chapter: 'one', order: 2 }));
  await writeFile(join(dir, 'two.md'), withBlock({ type: 'chapter', book: 'a-book', chapter: 'two', order: 2 }));
  await writeFile(join(dir, 'book.md'), `---\nstorylark:\n  type: book\n  book: a-book\n---\n`);

  const result = validateContentFolder(dir);
  const tie = result.errors.find((e) => e.code === 'order_tie');
  assert.ok(tie, `expected order_tie among [${result.errors.map((e) => e.code).join(', ')}]`);
  assert.match(tie.message, /one\.md/);
  assert.match(tie.message, /two\.md/);
});

test('a chapter naming a book nothing in the folder declares is unknown_book', async (t) => {
  const { dir, cleanup } = await tempFolder();
  t.after(cleanup);
  await writeFile(join(dir, 'orphan.md'), withBlock({ type: 'chapter', book: 'nowhere', chapter: 'one', order: 1 }));

  const result = validateContentFolder(dir);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'unknown_book');
  assert.match(result.errors[0].message, /nowhere/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. The real CLI binary, spawned for real
 * ──────────────────────────────────────────────────────────────────────────── */

test('CLI: exits 0 and prints a summary for a clean folder', async (t) => {
  const { dir, cleanup } = await tempFolder();
  t.after(cleanup);
  await writeFile(join(dir, 'a.md'), withBlock({ type: 'story' }));
  await writeFile(join(dir, 'ignored.md'), 'No block here.\n');

  const res = await execFileAsync('node', [CLI, dir]);
  assert.match(res.stdout, /1 candidate/);
  assert.match(res.stdout, /1 not StoryLark content/);
  assert.match(res.stdout, /no problems/);
});

test('CLI: exits 1 and prints the stable code for a malformed folder', async (t) => {
  const { dir, cleanup } = await tempFolder();
  t.after(cleanup);
  await writeFile(join(dir, 'bad.md'), withBlock({ type: 'novella' })); // unknown_type

  await assert.rejects(
    () => execFileAsync('node', [CLI, dir]),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /unknown_type/);
      assert.match(err.stderr, /bad\.md/);
      return true;
    }
  );
});

test('CLI: refuses a path that is not a directory', async () => {
  await assert.rejects(
    () => execFileAsync('node', [CLI, join(tmpdir(), 'storylark-validate-content-does-not-exist')]),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /not a directory/);
      return true;
    }
  );
});
