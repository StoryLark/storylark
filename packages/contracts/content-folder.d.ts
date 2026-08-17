// Types for content-folder.mjs — the folder-walking wrapper around the
// content contract, used by the `storylark-validate-content` CLI (AB#7474).

import type { ContentError } from './content';

export interface ContentFolderResult {
  /** Every `.md` file found under the folder. */
  checked: number;
  /** Files with no `storylark:` block — not StoryLark content, correctly skipped, never an error. */
  ignored: number;
  /** Files that carried a `storylark:` block and were judged, whether or not they passed. */
  candidates: number;
  /** The gate's rejections, verbatim — the same code, message and field a live transport would produce. */
  errors: ContentError[];
}

/**
 * Walk `rootDir` recursively for markdown files and validate every one that
 * carries a `storylark:` block through the real content contract
 * (`requireBlock: true` — the repo transport's rule). The only logic here is
 * the folder walk; every pass/fail decision comes from
 * `validateChapterCandidate` / `validateBookCandidate`.
 */
export function validateContentFolder(rootDir: string): ContentFolderResult;
