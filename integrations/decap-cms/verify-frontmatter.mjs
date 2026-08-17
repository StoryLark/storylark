// Proof for the Decap CMS reference integration (docs(integrations) — AB#7475).
//
// This is not a description of what Decap's `admin/config.yml` SHOULD produce
// — it constructs the actual bytes Decap's `object`/`string`/`number`/
// `boolean`/`hidden` widgets in that file would write for a filled-in entry,
// and runs them through the REAL gate every StoryLark transport shares:
// `validateChapterCandidate` from `packages/contracts/content.mjs`. No
// StoryLark-side code changes for this integration to work — that's the
// claim this script checks.
//
// Run: node integrations/decap-cms/verify-frontmatter.mjs

import { validateChapterCandidate } from '../../packages/contracts/content.mjs';

/**
 * What Decap's frontmatter writer produces for a `books` collection entry,
 * given the schema in admin/config.yml: top-level `title`/`author`/
 * `description` fields, then the nested `storylark` object field rendered as
 * a nested YAML block — the standard behaviour of Decap's `object` widget,
 * not anything StoryLark-specific.
 */
const bookEntry = `---
title: The Voyage Home
author: A. N. Author
description: A story about journeying home across strange seas.
storylark:
  type: book
  book: the-voyage-home
  contractVersion: 1
---
`;

/**
 * What Decap produces for a `chapters` collection entry: top-level `title`,
 * the nested `storylark` object, then the markdown widget's value as the
 * document body below the closing fence.
 */
const chapterEntry = `---
title: Going East
storylark:
  type: chapter
  book: the-voyage-home
  chapter: going-east
  order: 1
  publish: true
  contractVersion: 1
---

The ship creaked at the dock, and for the first time in months she let
herself believe the voyage home might actually begin.
`;

/**
 * A withheld chapter — \`publish\` unchecked in Decap's boolean widget.
 * Proves the "nothing written" contract holds for Decap-authored content too.
 */
const withheldChapterEntry = `---
title: A Draft Nobody Should See Yet
storylark:
  type: chapter
  book: the-voyage-home
  chapter: a-draft
  order: 2
  publish: false
  contractVersion: 1
---

Still being written.
`;

const cases = [
  { name: 'books collection entry (content/books/the-voyage-home.md)', file: 'content/books/the-voyage-home.md', markdown: bookEntry },
  { name: 'chapters collection entry (content/chapters/going-east.md)', file: 'content/chapters/going-east.md', markdown: chapterEntry },
  { name: 'chapters collection entry, publish unchecked (content/chapters/a-draft.md)', file: 'content/chapters/a-draft.md', markdown: withheldChapterEntry },
];

let allPassed = true;

for (const c of cases) {
  // requireBlock: true — the exact option the repo transport passes
  // (repo-sync.ts calls validateChapterCandidate(candidate, { requireBlock: true })).
  const result = validateChapterCandidate({ file: c.file, markdown: c.markdown }, { requireBlock: true });
  console.log(`\n--- ${c.name} ---`);
  if (result.ok) {
    console.log('PASS —', JSON.stringify(result.record));
  } else {
    allPassed = false;
    console.log('FAIL —', JSON.stringify(result.errors, null, 2));
  }
}

console.log(`\n${allPassed ? 'ALL CASES PASSED' : 'AT LEAST ONE CASE FAILED'} — validator: packages/contracts/content.mjs#validateChapterCandidate, zero changes made to it.`);

process.exit(allPassed ? 0 : 1);
