# Design: Content Editing in the Admin Portal

How a chapter that is already published gets opened, edited, and republished
from a browser — and why that required changing what a publish uploads before
any of it was possible.

**No diagram is committed for this yet.** The flow it would show is the same
one [`content-flow.md`](content-flow.md) already diagrams, plus the two new
keys under `books/<id>/`; a `.drawio` for it is outstanding work, not a
deliberate omission.

## The blocker, which was not a UI problem

Publishing used to be strictly one-way: local markdown → parse → TTS → upload →
manifest. **The source markdown never left the machine that ran the publish**,
and publish state lived in `.storylark/state/<bucket>.json` on that one machine.

That is the whole reason there was no editing story. It was never that nobody
had built the textarea — it was that the deployment had no copy of what it was
built from, so there was nothing for a browser to open. Any editor built on top
of that model would have had to reconstruct source from the derived block JSON,
which is lossy, or keep its own separate copy, which would drift.

## The fix: the deployment stores its own source

`packages/pipeline/publish.mjs` now uploads the source alongside the derived
artifacts:

```
books/<book-id>/
  source/book.json              ← NEW — book metadata as authored
  source/<chapter>.md           ← NEW — the editable source of truth
  images/<name>-<hash>.<ext>    ← NEW — inline story art
  chapters/<id>.<hash>.json     derived, immutable
  audio/<id>.<hash>.mp3         derived, immutable
  timings/<id>.<hash>.json      derived, immutable
  covers/cover.<hash>.<ext>     cover art, immutable
  revisions/<chapter>/…         text history, written by the portal
manifest.json                   the generated index the app reads
```

Everything else follows from that one change. The CLI keeps working unchanged
against the same model; the portal can now genuinely list → open → edit → save
→ republish.

Source is uploaded for **every** chapter that has any, not just changed ones,
because "changed" is measured against the derived content hash — a chapter can
be byte-identical after parsing while its source has never been uploaded at all
(which is true of every chapter, the first time). It is tracked separately in
publish state so repeat publishes upload nothing.

## How the backend knows a book has fifteen chapters

Worth restating, because it constrains everything here and the editing surface
had to respect it rather than invent a second model.

**On disk, the folder is the book.** A chapter belongs to a book because it sits
in that book's folder. Order comes from the numeric filename prefix, which is
then stripped to form the chapter id (`02-the-long-dark.md` → `the-long-dark`).
A loose `.md` at the top level is shorthand for a one-chapter book. See
[`authoring-stories.md`](../authoring-stories.md).

**After publishing, `manifest.json` records it.** The app never scans anything —
publishing walks the folders once and writes an index of each book and its
ordered chapter list.

**The consequence for editing:** the manifest is *generated*, not edited, so
every editing action has to regenerate it. A text edit changes the content hash,
word count and reading time; adding or deleting changes the chapter list. So
**"save" in the portal always means "rewrite the manifest too"** — with the
chapter JSON written first and the manifest last, the same ordering rule the
pipeline follows, so a reader can never see a manifest pointing at an object
that isn't there yet.

## What the Worker does and deliberately does not do

It is not a second publish pipeline. `packages/worker/src/lib/content.ts` does
the strict subset a text edit needs and that has to be instant to be worth
having: re-parse one chapter, write its content JSON, rewrite its manifest
entry, mark the narration stale.

It does **no narration**, and that is a real constraint stated rather than
hidden: a Cloudflare Worker cannot run the TTS model. So a portal edit publishes
text instantly and marks the chapter `audioStale`; the portal says so on the
chapter, in those words, and the next pipeline run re-narrates and clears it.
Text republishes everywhere immediately; audio catches up.

### The markdown rules exist twice, on purpose

`packages/pipeline/lib/md.mjs` (Node) and `packages/worker/src/lib/md.ts`
(Worker) implement the same block rules. Three alternatives were considered:

| Option | Why not |
|---|---|
| Worker imports the pipeline | `storylark-pipeline` depends on kokoro-js, `@huggingface/transformers`, sharp and the MS Speech SDK — hundreds of megabytes of Node-only code with no business in a Workers isolate. |
| Pipeline imports the Worker | The publish CLI runs under plain `node`, so it can't consume `.ts`, and it would make the content tool depend on the API server. |
| A third shared package | Correct in the abstract, but it's a package that isn't on npm yet, and this repo has already shipped a release referencing something unpublished once. |

So instead of hoping they stay in step,
`packages/worker/test/md-parity.test.mjs` asserts they produce byte-identical
output — blocks, spans, word counts, content hashes, block-id stabilisation —
over a corpus covering every block type plus the repo's real example books.
`npm test` runs it. If either drifts, a chapter edited in the portal would
publish differently from the same chapter published by the CLI, and that test
fails first.

The one intentional difference: `contentHash` and `stabilizeBlockIds` are async
on the Worker side, because Web Crypto has no synchronous digest. Same SHA-256
over the same input, so the same hex out.

## The correction rule

The manifest carries the version that drives the new-content notification. A
typo fix must not bump it the way a genuinely new chapter does, or every small
correction pings every reader's phone.

Naively that reads as "a correction doesn't bump the version" — but that would
be a correction nobody ever receives, because the version is also the only thing
that makes a reader re-fetch the manifest at all. So the one event is split into
the two it always was:

| | Correction | Publication |
|---|---|---|
| `manifest_version` (database, `/api/library/version`) | bumped | bumped |
| `manifest.libraryVersion` | bumped | bumped |
| `manifest.announceVersion` | unchanged | bumped |
| Push fan-out | none | every subscription |
| In-app "new content" badge | no | yes |

The badge compares against `announceVersion`, falling back to `libraryVersion`
when it's absent — which is exactly the old behaviour on a manifest written by
an older pipeline.

The portal defaults the flag ON for an edit to existing content and OFF for a
chapter that didn't exist yet, and the API applies the same defaults for a
client that omits it: accidentally announcing a typo fix to every subscriber is
the failure worth defaulting against.

## Revisions

Five text revisions per chapter, configurable with `CONTENT_REVISIONS`.

- **Text only, never audio.** Narration is megabytes per chapter and always
  regenerable from the text; versioning it would balloon storage for nothing.
  N text revisions, exactly one current audio set.
- **The live revision is pinned** and cannot be aged out by the limit.
- **The first portal edit to a CLI-published chapter seeds history** from the
  pre-edit source, so the safety net exists on the first save rather than
  arriving one edit too late.
- **A revert is an ordinary save.** It reads the old text and puts it back
  through the same parse → hash → write → manifest path, which means it appends
  a *new* revision rather than rewinding the list. The history of what happened
  is preserved, including the revert, and the revision reverted from is still
  there if the revert was the mistake.
- **A revert marks the audio stale**, for the same reason an edit does: rolling
  text back leaves narration matching the version just discarded.

Bodies live at `books/<book>/revisions/<chapter>/<id>.md` with a small
`index.json` beside them. Index-driven rather than listing-driven, which is why
the storage seam needs only `get`, `put` and `delete` — no ordered, paginated,
metadata-carrying listing API that every provider spells differently.

## The storage seam

`packages/worker/src/lib/content-store.ts` declares `ContentStore` and ships one
driver: R2, over the `CONTENT` binding the Worker already has. No credential, no
network hop, no new configuration on Cloudflare.

Everything else is bound by the platform entry that already holds the
credentials — `platforms/azure/content-store.mjs` provides an Azure Blob driver
and a local-directory driver. That keeps the Azure SDK out of the Worker bundle
entirely and makes adding a provider a file in `platforms/`, not a change to the
engine.

The local-directory driver mirrors the object layout one-for-one, which is the
same shape `publish.mjs --local <dir>` produces — so a site can be published,
served and edited end to end with no cloud account, which is also what makes
this path testable.

## The two shapes

A single work (one book, ordered chapters) and a growing set of short stories
(many books of one chapter each) are the same data model and a completely
different job to sit in front of. The presentation's `layout` already
distinguishes them and is runtime data, so the portal reads it instead of
showing one generic tree:

- **`series`** → Books, then the chapters inside the one you picked.
- **`flat`** → Stories. One click opens the story's only chapter, and the cover
  *is* the title illustration, so it's offered on the story itself.

## Images

Three jobs, one endpoint:

1. **Cover / title illustration** — `kind=cover`, stored at
   `books/<id>/covers/cover.<hash>.<ext>` (the same key shape `publish.mjs`
   uses, so CLI and portal results are interchangeable) and written into the
   manifest.
2. **Inline art** — `kind=inline`, stored at `books/<id>/images/<name>-<hash>.<ext>`.
   The response carries the exact `![alt](url)` markdown, which the editor
   inserts at the cursor. The author never types a URL and never has to know
   where storage lives.
3. **Rendering** — the reader renders an image block as a `<figure>` with the
   alt text both on the `<img>` and as a visible caption, and the offline layer
   caches every image a downloaded chapter references so a downloaded story
   isn't missing its art.

Filenames are content-hashed because these are served with immutable caching:
re-uploading under a name already in a reader's cache would otherwise never be
seen. SVG is refused — it is a script-carrying document served to the same
browser as the app.

Offline image caching is best-effort per image. Art can live on a marketing
origin that sends no CORS headers, and a cross-origin fetch there comes back
opaque, which `cache.put` refuses. Letting one such image fail the whole
download would mean a story with one decorative image could never be taken
offline at all; a missed image degrades to the alt text the renderer already
shows.

## Relationship to `POST /api/admin/publish-story`

Both stay. They are different paths for different deployments:

| | `/publish-story` | Content editing |
|---|---|---|
| Needs | `GITHUB_REPO` + `GITHUB_DEPLOY_TOKEN` | a writable content store |
| Scope | one NEW single-chapter story | any chapter of any book, edit in place |
| Audit trail | `git log` on the site's repo | revision history in storage |
| Narration | yes — CI can run the TTS model | no — a Worker cannot |

Unifying them was considered and rejected: the GitHub path's whole value is that
the repo stays the audit log and CI does the narration, and folding it into a
direct storage write would delete both. A site with a repo keeps using it for
new work; every site, repo or not, can now fix a typo. See
[`admin-publish.md`](admin-publish.md).

## Two copies of the source now exist

The deployment has one and the operator's working tree has one, and the pipeline
reads the operator's. That is a real hazard — a portal edit followed by a
routine CLI publish would overwrite the edit — and it is handled explicitly
rather than papered over:

- `publish.mjs --pull` fetches the deployment's source back into the working
  tree before parsing. One-way, deployment → local, only when asked. A publish
  that silently rewrote someone's working tree would be worse than the problem.
- The library version is seeded from the live manifest, not only from local
  publish state, so a laptop that has fallen behind can't write a version that
  goes backwards and is therefore never re-fetched.

What this does **not** yet do is detect the conflict for you: a publish without
`--pull` still overwrites, and nothing warns. That is the honest limit of this
iteration.
