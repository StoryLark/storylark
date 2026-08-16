---
'storylark-pipeline': minor
'storylark-worker': minor
'storylark-core': minor
---

Per-block re-narration, chapter reorder, and conflict detection between a
portal edit and a CLI publish — the three items plan §3 listed as "NOT built"
(AB#7412).

**Per-block re-narration.** `publish.mjs` re-synthesizes only the blocks whose
spoken text actually changed and splices the rest of the audio back in from the
previous run. The new `packages/pipeline/lib/block-audio.mjs` keeps a
content-addressed cache of the per-block chunks the TTS providers already emit,
keyed by a hash of each block's type and spoken text — the same hash
`stabilizeBlockIds` matches on, and deliberately not the block's id or
position, so inserting a paragraph at the top of a chapter renumbers every
block after it and still costs one block of narration. Reordering paragraphs,
or reverting to text narrated before, costs nothing. The splice is the existing
`stitchChapter()`: the chunk list is rebuilt in the chapter's current order and
every block's `startMs` and word timings are re-derived from measured (ffprobe)
durations, so word-sync highlighting stays correct across a partial
re-narration. A metered provider's character budget is now charged for what is
actually sent, and `--dry-run` reports the cost per chapter before it is paid.
New `--renarrate-all` ignores the cache. An empty cache behaves exactly as
before, so deleting `.storylark/work/` costs a re-narration and never a wrong
one.

**Chapter reorder.** `PUT /api/admin/content/books/<b>/chapter-order` plus
Up/Down controls in the portal's chapter list. The order of `book.chapters` in
the manifest already *is* the chapter order, so there is no new position field;
the route takes the whole order and verifies it is a permutation of what the
manifest holds, so a browser tab left open through a publish cannot delete a
chapter by omitting it. Never announced — rearranging a table of contents is
not new writing.

**Conflict detection, both directions.** `publish.mjs` now reads the live
manifest *before* it uploads anything and refuses — exit 2, naming each chapter
and all three hashes — when the live content differs both from what this
machine last published and from what this run is about to write. That leaves
the ordinary case silent and never refuses a `--pull`-then-publish, since after
a pull the deployment already holds what is about to be written. A chapter that
exists live with no local file is refused too, because regenerating the
manifest without it would unpublish a story written in the portal. `--force`
overrides; chapter-order and book-metadata divergence are warnings rather than
refusals. On the portal side the editor sends the `contentHash` it opened at as
`baseContentHash`, and a save against a superseded version is refused with
`409 stale_edit` offering three honest choices — download the draft, load the
live version, or overwrite deliberately. Requests that send no base hash behave
exactly as before.

**Fixes a real bug this surfaced:** `stabilizeBlockIds` could emit DUPLICATE
block ids. Insert a paragraph at the top of a chapter and the new block kept
its freshly-parsed `b001` while the old first paragraph inherited the same
`b001` from the previous publish. That broke three things at once — `stitch.mjs`
keys word timings by block id, so the second block silently took the first's
timings and word-sync went wrong from there on; reader progress and bookmarks
address a block by id; and the chapter's content hash stopped being idempotent,
so republishing an unchanged file produced a new hash every time. Fixed in both
implementations (`packages/pipeline/lib/md.mjs` and
`packages/worker/src/lib/md.ts`) with an extra pass that reserves inherited ids
before any parsed id is kept. A chapter with no collision comes out
byte-for-byte as before, so no existing content re-hashes.

Also closes the "authenticated Node/Azure path is untested end to end" gap:
`packages/worker/test/node-postgres-admin-content.test.mjs` runs the real Hono
app over the real Postgres driver and the real Node content-store driver
against a real Postgres, creating an operator through the real installer flow
and exercising save, preview, download, revisions, revert, reorder, conflict
and delete through a real session cookie. It skips loudly without
`STORYLARK_TEST_POSTGRES` rather than passing on a mock.
