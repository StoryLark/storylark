#!/usr/bin/env node
// storylark-validate-content — dry-run a folder of markdown against the REAL
// content gate before pushing it through any transport (D5 "conformance
// tooling", AB#7474 — the last piece of the content-standards plan; see
// storylark-ops/pmo/scf-v1.md and docs/authoring-stories.md).
//
// This matters most for the reference CMS integration work: a git-based CMS
// that commits markdown into a connected repo, whose users need a way to
// self-check before syncing rather than finding out from a sync report.
//
// ── Not a second opinion ─────────────────────────────────────────────────
// This tool contains NO validation logic of its own. It calls the exact
// same exported functions the portal, the repo sync and the public API call
// (`storylark-contracts/content`, via the folder-walking wrapper in
// `../content-folder.mjs`) — the same gate, the same stable codes, the same
// messages. If a file passes here, it passes through the repo transport for
// the same reason; if it fails here, it fails there with an identical error.
//
// Usage:
//   npx storylark-validate-content <path>
//   node packages/contracts/bin/validate-content.mjs <path>
//
// Output: silence for every file with no `storylark:` block — a file
// without the block is not StoryLark content, and that is not an error
// (the opt-in rule, scf-v1.md §2). Every file that carries a block and
// fails prints one line per problem: the file, the stable code, the message,
// and the field, where the gate names one.
//
// Exit code: 0 if nothing with a `storylark:` block failed, 1 otherwise.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateContentFolder } from '../content-folder.mjs';

const target = process.argv[2];

if (!target || target === '--help' || target === '-h') {
  console.error(
    'storylark-validate-content — dry-run a markdown folder against the real content gate.\n\n' +
      '  storylark-validate-content <path>\n\n' +
      'Silence for files with no `storylark:` block — not StoryLark content, not an error.\n' +
      'Exit 0 if nothing with a block failed, 1 otherwise.\n'
  );
  process.exit(target ? 0 : 1);
}

const root = resolve(process.cwd(), target);
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`✗ ${target} is not a directory.`);
  process.exit(1);
}

const result = validateContentFolder(root);

for (const e of result.errors) {
  const where = [e.file, e.line !== undefined ? `line ${e.line}` : undefined].filter(Boolean).join(', ');
  console.error(`✗ ${where ? `${where}: ` : ''}[${e.code}]${e.field ? ` (${e.field})` : ''} ${e.message}`);
}

console.log(
  `\n${result.checked} file(s) checked, ${result.ignored} not StoryLark content (no \`storylark:\` block), ` +
    `${result.candidates} candidate(s), ${result.errors.length ? `${result.errors.length} problem(s)` : 'no problems'}.`
);

process.exit(result.errors.length ? 1 : 0);
