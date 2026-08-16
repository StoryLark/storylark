# Content Pipeline

The publish pipeline (`packages/pipeline/publish.mjs`) turns your source content into
everything the app reads: chapter JSON, narrated MP3 audio, per-word timing
files, cover images, and a library manifest — uploaded to the brand's content
storage. The default source format is plain markdown (see
[`authoring-stories.md`](authoring-stories.md)) — no parser needed. Bring your
own parser (`--parser`) only if your content lives in some other shape.

```
your source (markdown by default)
   │  built-in markdown importer, or --parser <your-module.mjs> for other shapes
   ▼
packages/pipeline/publish.mjs
   ├─ diff by content hash (only changed chapters proceed)
   ├─ chapter JSON                          books/<id>/chapters/<ch>.<hash>.json
   ├─ Azure neural TTS per block → stitch   books/<id>/audio/<ch>.<hash>.mp3
   │    + word timings                      books/<id>/timings/<ch>.<hash>.json
   ├─ covers (hashed)                       books/<id>/covers/cover.<hash>.<ext>
   ├─ manifest.json (uploaded LAST)         manifest.json
   └─ POST /api/admin/publish → web push
```

## Command

```
node packages/pipeline/publish.mjs --brand <id> --source <path> [flags]
```

The two required flags:

| Flag | Required | Meaning |
|---|---|---|
| `--brand <id>` | yes | Selects `brands/<id>/brand.json` + `deployment/<id>/deployment.json` and the content bucket `<id>-content`. |
| `--source <path>` | yes | Path to your content source — a `books/` folder in the [markdown format](authoring-stories.md) by default. |

> The root `npm run publish` script only passes `--brand storylark`, so it will
> exit with the usage message on its own. Append the rest after `--`, e.g.
> `npm run publish -- --source examples/demo`.

### Optional flags

| Flag | Effect |
|---|---|
| `--book <id>` | Publish only this book/unit. |
| `--no-audio` | Skip TTS — text-only publish. Listen mode then uses the on-device Web Speech fallback. Required if you don't have Azure Speech credentials. |
| `--local <dir>` | Mirror the storage layout into `<dir>` on disk instead of uploading to a remote bucket/container. **No cloud account needed.** Serve `<dir>` at the brand's `contentOrigin` (e.g. `--local app/dist` for same-origin dev). |
| `--storage r2\|azure-blob` | Which storage driver to publish through (default `r2`). See [`deploy-azure.md`](deploy-azure.md) for the Azure path. |
| `--parser <module>` | Use a site-owned parser instead of the built-in markdown importer — for content that isn't plain markdown. Contract below. |
| `--dry-run` | Parse + report the change plan only. No TTS, no upload. |
| `--manifest-only` | Regenerate and re-upload just the manifest (after a manifest-schema change), without re-publishing chapters. Requires all chapters to have been published before. |
| `--pull` | **Before** parsing, fetch each chapter's source markdown back from the live deployment and write it into your source repo. This is how an edit made in the admin portal reaches your machine instead of being overwritten by this publish. One-way (deployment → local) and only when asked. See "Editing on the deployment" below. |
| `--no-source` | Don't upload the source markdown — derived artifacts only, the pre-0.12 behaviour. The deployment then can't be edited from its own admin portal. |
| `--origin portal\|cli\|sync` | What to record as this content's `origin` in the manifest. Defaults to whatever the live manifest already says, falling back to `cli` — so an ordinary republish never relabels where content came from. Set to `sync` by `sync.mjs`; you should not normally pass it by hand, because `sync` makes content read-only in the admin portal. See [`content-sync.md`](content-sync.md). |
| `--sync-kind`, `--sync-url`, `--sync-ref`, `--sync-path` | Recorded alongside `--origin sync`: which connector produced this book and where its real source of truth lives, so the portal can say "edit at source" with a link. Never a credential — the manifest is public. |

### A publish only removes books it could have produced

The manifest is regenerated from what was parsed, so a book you delete from your
source is unpublished — that is the intended behaviour for content this pipeline
owns. It is **not** applied to content it doesn't own: a run publishing `sync`
carries live `portal` and `cli` books through untouched, and a run publishing
`cli` (the default) carries live `sync` and `portal` books through. Otherwise a
sync would silently delete every story written in the portal, and the next CLI
publish would silently delete the synced catalogue.

`--book <id>` narrows the *publish*, not the *library*: books not named are kept
as they already are rather than dropped.

For a library that is entirely CLI-published — the only shape that existed before
0.13 — none of this changes anything.

### Syncing from an external source

`packages/pipeline/sync.mjs` pulls a library from a git repository of markdown or
from a publisher's own JSON feed, stages it in the blessed layout, and then runs
**this** pipeline over it with `--origin sync`. There is no second publish path:
change detection, narration, upload and manifest ordering are all the same code.
See [`content-sync.md`](content-sync.md).

### Environment

| Var | For | Notes |
|---|---|---|
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | TTS audio | Required unless `--no-audio`. The pipeline exits if audio is wanted but these are unset. |
| `ADMIN_KEY` | Push notify | Sent as `X-Admin-Key` to `POST /api/admin/publish` as the final step. If unset, notify is skipped (publish still succeeds). Always skipped in `--local` mode. |

`ffmpeg` and `ffprobe` must be on `PATH` for the audio stitch step
(`packages/pipeline/stitch.mjs`).

## The parser contract

The pipeline never assumes your content format. You provide an ESM module whose
default export (or a named `parse` export) is:

```js
export async function parse(sourceRepo, previousChapters, siteOrigin) {
  // sourceRepo       — the --source path
  // previousChapters — state.chapters from the last publish, keyed "bookId/chapterId"
  //                     (use it to keep block IDs stable across edits)
  // siteOrigin       — marketing origin (appOrigin with the `app.` label dropped),
  //                     used to resolve root-relative image srcs
  return {
    books: [
      {
        book: { id, title, author, description?, order?, series?, /* ... */ },
        chapters: [
          {
            id, title, label?, blocks, charLength, wordCount, readingTime?, setting?
          }
        ]
      }
    ]
  };
  // A bare array of the same `{ book, chapters }` items is also accepted.
}
```

`blocks` are StoryLark content blocks (`paragraph` with `em`/`strong` spans,
`scene-break`, `display-beat`, `message-block`, `image`, `end-marker`). You don't
have to build these by hand: `packages/pipeline/lib/md.mjs` exports helpers the bundled
parser uses —

- `readFrontmatter(source)` — flat `key: value` frontmatter.
- `parseBlocks(body, { siteOrigin })` — markdown prose → blocks (conventions below).
- `chapterCharLength(blocks)`, `countWords(blocks)`.
- `stabilizeBlockIds(blocks, previousBlocks)` — reuses a block's prior ID when its
  text is unchanged, so bookmarks and reading positions survive edits elsewhere.

### Markdown block conventions (`parseBlocks`)

| Source | Block |
|---|---|
| `---` on its own | `scene-break` |
| `> **Name (time):** text` (consecutive quotes merge) | `message-block` |
| `![alt](url)` on its own line | `image` (never narrated) |
| `*End of X.*` | `end-marker` |
| `*whole-line italic*` | `display-beat` |
| anything else | `paragraph` with `em`/`strong` spans |

`examples/demo/books/` is a working example of the default markdown format
(see [`authoring-stories.md`](authoring-stories.md)) — the fastest way to try
the pipeline end to end, no parser needed:

```
node packages/pipeline/publish.mjs --brand storylark \
  --source examples/demo --no-audio --local app/dist
```

## Incremental, content-hash publishing

Every chapter is hashed (`contentHash({ blocks, title })`, first 8 hex chars).
The pipeline keeps a per-brand state file at `.storylark/state/<brand>.json`
recording each chapter's last hash, audio info, and publish date. On each run it:

1. Parses everything and computes each chapter's current hash.
2. Publishes **only** chapters whose hash changed (others are untouched — no
   re-TTS, no re-upload). `--dry-run` prints this plan without acting.
3. Writes chapter JSON, and (unless `--no-audio`) synthesizes + stitches audio and
   timings.
4. Uploads artifacts under **content-hashed, immutable** keys
   (`<ch>.<hash>.json` / `.mp3`), so a republished chapter gets a *new* key and
   old downloads keep working until re-fetched.
5. Uploads `manifest.json` **last** (short TTL), so readers never see a manifest
   pointing at objects that aren't uploaded yet.
6. If `ADMIN_KEY` is set and not `--local`, POSTs the new version to
   `/api/admin/publish` to fan out push notifications.

Covers are handled similarly: a book's `coverSource` (art in your source repo's
`public/`) or `brands/<id>/assets/covers/<bookId>.<ext>` is hashed and uploaded
under `covers/cover.<hash>.<ext>`; books with no art fall back to the brand icon.

## TTS and word timings

Audio is generated **at publish time**, once per chapter revision (not on
demand). The voice named in `deployment/<id>/deployment.json` `tts.voice` picks the
provider:

- **Bundled local voices (the default — free, no account).** Kokoro voice ids
  (`af_heart`, `bm_fable`, …) run the Apache-licensed **Kokoro-82M** model on
  your own machine via `packages/pipeline/tts-kokoro.mjs`. 28 English voices ship with it;
  the model (~90 MB) downloads on first use and is cached. Word timings are
  estimated: each sentence's duration is exact, and words inside it are
  apportioned by length — accurate enough for read-along highlighting.
  `af_heart` is StoryLark's default narrator.
- **Azure neural TTS (optional premium tier — bring your own key).**
  `packages/pipeline/tts.mjs` calls Azure one block at a time, using voices like
  `en-US-Ava:DragonHDOmniLatestNeural`, and collects a **WordBoundary event**
  per spoken word (character offset + 100 ns audio offset). Requests are spaced
  to respect the Azure F0 free-tier rate limit (20 req/min) with retry/backoff
  on transient throttling. Requires `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`.
- `packages/pipeline/stitch.mjs` concatenates the per-block MP3 chunks into one chapter file
  (with a short beat of silence for scene breaks) and shifts each block's word
  times by the **measured** (ffprobe) chunk offsets — trailing silence would
  otherwise drift a naive sum.
- The result is a timings JSON of `[charStart, charEnd, startMs, endMs]` per word,
  which the reader uses for word-synced highlighting and tap-to-seek. See
  [`read-along.md`](read-along.md).

A **monthly character budget** (hard stop at 450K, under the Azure F0 500K/month
limit) is tracked in the state file's `charLedger`; a publish that would exceed it
aborts with guidance to use `--no-audio` or wait for the next month. The budget
applies to Azure voices only — the bundled local voices are unmetered.

Chapters published `--no-audio` (`hasAudio: false` in the manifest) fall back to
the device's own Web Speech synthesis for Listen mode — always available, lower
quality.

## Output layout (R2 / `--local` dir)

```
manifest.json                              library catalog + version (~60s cache)
books/<bookId>/
  source/book.json                         book metadata as authored (~60s cache)
  source/<chapterId>.md                    the editable source markdown (~60s cache)
  chapters/<chapterId>.<hash>.json         blocks + metadata (immutable)
  audio/<chapterId>.<hash>.mp3             48kHz/96kbps mono (immutable)
  timings/<chapterId>.<hash>.json          per-word timing (immutable)
  covers/cover.<hash>.<ext>                cover art (immutable)
  images/<name>-<hash>.<ext>               inline story art (immutable)
```

`source/` and `images/` are what make the deployment self-describing. Until
they existed, publishing was one-way — markdown in, artifacts out — and the
source never left the machine that ran the publish, which is why nothing could
be edited anywhere but there. See
[`design/admin-content-editing.md`](design/admin-content-editing.md).

## Editing on the deployment

Once source markdown is uploaded, the admin portal can open, edit and republish
any chapter without a repo, a laptop or a CI run. That creates one thing to be
aware of: **two copies of the source now exist**, one on the deployment and one
in your working tree, and this pipeline reads yours.

`--pull` is the reconciliation, and it is explicit rather than automatic — a
publish that silently rewrote your working tree would be worse than the problem
it solves:

```bash
node packages/pipeline/publish.mjs --brand <id> --source <path> --pull
```

It reads the live manifest over the public content origin (no credential — the
content is public and this direction only reads), fetches each chapter's
`source/<chapter>.md`, and writes it into your repo, matching chapters to files
by the same rule the importer uses to derive a chapter id from a filename. So
`02-the-long-dark.md` is recognised as chapter `the-long-dark` and rewritten in
place, keeping its ordering prefix. A chapter created in the portal that has no
local file lands as `books/<book>/<chapter>.md`; rename it to give it an order.

Two related behaviours exist for the same reason:

- **The library version is seeded from the live manifest**, not only from local
  publish state. The portal bumps the deployed manifest's version on every
  edit, so a machine that has been publishing for a while can hold a lower
  number — and a manifest whose version goes backwards is a manifest no reader
  ever re-fetches, i.e. a publish that reaches nobody.
- **`audioStale` is derived, not asserted.** A chapter is marked audio-out-of-
  date exactly when it has narration whose hash isn't the current content hash.
  That covers a `--no-audio` publish of changed text as well as a portal edit,
  and it clears itself on the run that re-narrates.

The bucket is named `<brand>-content`; an R2 custom domain serves the bucket root
at the brand's `contentOrigin`, which is exactly what the app fetches from
(`packages/core/src/brand.ts` `contentUrl()`). More on the storage/caching model in
[`data-model.md`](data-model.md).
