# Content Pipeline

The publish pipeline (`packages/pipeline/publish.mjs`) turns your source content into
everything the app reads: chapter JSON, narrated MP3 audio, per-word timing
files, cover images, and a library manifest — uploaded to the brand's R2 bucket.
It is **brand-neutral**: your site owns the parser that reads *your* content
shape; the pipeline handles TTS, stitching, hashing, upload, manifest, and
notify.

```
your source (markdown, etc.)
   │  --parser <your-module.mjs>            (site-owned; produces canonical shape)
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
node packages/pipeline/publish.mjs --brand <id> --source <path> --parser <module> [flags]
```

The three required flags:

| Flag | Required | Meaning |
|---|---|---|
| `--brand <id>` | yes | Selects `brands/<id>/brand.json` and the content bucket `<id>-content`. |
| `--source <path>` | yes | Path to your content source (passed straight to your parser). |
| `--parser <module>` | yes | Path to your site-owned parser module (contract below). |

> The root `npm run publish` script only passes `--brand storylark`, so it will
> exit with the usage message on its own. Append the rest after `--`, e.g.
> `npm run publish -- --source examples/demo --parser examples/demo/parser.mjs`.

### Optional flags

| Flag | Effect |
|---|---|
| `--book <id>` | Publish only this book/unit. |
| `--no-audio` | Skip TTS — text-only publish. Listen mode then uses the on-device Web Speech fallback. Required if you don't have Azure Speech credentials. |
| `--local <dir>` | Mirror the R2 layout into `<dir>` on disk instead of uploading to a remote bucket. **No Cloudflare account needed.** Serve `<dir>` at the brand's `contentOrigin` (e.g. `--local app/dist` for same-origin dev). |
| `--dry-run` | Parse + report the change plan only. No TTS, no upload. |
| `--manifest-only` | Regenerate and re-upload just the manifest (after a manifest-schema change), without re-publishing chapters. Requires all chapters to have been published before. |

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

See `examples/demo/parser.mjs` for a complete, working parser that reads the
public-domain markdown stories in `examples/demo/books/` — the fastest way to try
the pipeline end to end:

```
node packages/pipeline/publish.mjs --brand storylark \
  --source examples/demo --parser examples/demo/parser.mjs \
  --no-audio --local app/dist
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
demand). The voice named in `brand.json` `tts.voice` picks the provider:

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
  chapters/<chapterId>.<hash>.json         blocks + metadata (immutable)
  audio/<chapterId>.<hash>.mp3             48kHz/96kbps mono (immutable)
  timings/<chapterId>.<hash>.json          per-word timing (immutable)
  covers/cover.<hash>.<ext>                cover art (immutable)
```

The bucket is named `<brand>-content`; an R2 custom domain serves the bucket root
at the brand's `contentOrigin`, which is exactly what the app fetches from
(`packages/core/src/brand.ts` `contentUrl()`). More on the storage/caching model in
[`data-model.md`](data-model.md).
