# storylark-pipeline

## 0.6.0

### Minor Changes

- [`ccb4899`](https://github.com/StoryLark/storylark/commit/ccb489966335099c7f176c14934443885fed9b40) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Content upload now goes through a storage seam (`storage.mjs`,
  `resolveProvider`) instead of importing the Cloudflare R2 uploader
  directly. `r2-upload.mjs` stays the default, unchanged driver; a new
  `storage-azure.mjs` driver covers Azure Blob Storage. Select with
  `--storage r2|azure-blob` on `publish.mjs` or the `STORYLARK_STORAGE` env
  var.

  `--parser` is now optional. `lib/markdown-import.mjs` is the new default
  parser: the blessed StoryLark story format — one folder per book
  (`book.json` + numbered chapter `.md` files) or a single `.md` file as
  shorthand for a one-chapter book. `--parser` remains available for content
  in some other shape. See `docs/authoring-stories.md` for the format spec.

## 0.4.0

### Patch Changes

- [`95e38e0`](https://github.com/StoryLark/storylark/commit/95e38e00711cb3ffb8f86dad44777c1426d34e16) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Traceable build identity. The app version shown in Settings/About is now storylark-core's real npm version (the hand-bumped APP_VERSION counter is gone), and About gains a "Version & build" section listing the version of every installed storylark-\* package plus the solution build's git commit, build time, and brand. The Vite preset injects this at build time via `virtual:storylark-build`. RELEASE-NOTES.md headings are now keyed to the same version number. worker/pipeline: expose `./package.json` in exports so build tooling can read their versions.

## 0.3.0

### Minor Changes

- [`20d2df7`](https://github.com/StoryLark/storylark/commit/20d2df751b4c4c458aa766731fe0a630fbe8dc26) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Narrator voice picker — a library can now offer multiple narrator voices.

  - Pipeline: `brand.json` `tts.voices` lists every voice the library ships;
    extras publish as per-voice audio + word-timing tracks (with automatic
    backfill for already-published chapters), and the manifest carries a
    `voices` map of display names.
  - App: a "Narrator" picker appears in Settings whenever the library publishes
    2+ voices; the choice is synced across devices, applies on the next play,
    and downloads keep the chosen narrator available offline. Older manifests
    without voices keep working unchanged.

## 0.2.0

### Minor Changes

- [`67e24f6`](https://github.com/StoryLark/storylark/commit/67e24f685dcaa7beb9e0f89a85fb321fe8ebce54) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - First packaged release of the StoryLark engine — the three-layer model ships as
  installable packages:

  - `storylark-core` — the read-along PWA engine plus the `defineStorylarkConfig`
    Vite preset. A site is now `index.html` + a 3-line `entry.ts` + a 5-line
    `vite.config.ts` + a brand folder; theme, fonts, and config arrive through
    virtual modules, so `npm update storylark-core` can never touch a site's
    theme or presentation.
  - `storylark-worker` — the Hono API Worker, importable from a site's worker
    entry, with D1 migrations shipped under `./migrations`.
  - `storylark-pipeline` — the publish pipeline as a site-agnostic CLI
    (`storylark-publish`) with an injected, site-owned content parser; publish
    state lives in the site repo under `.storylark/`.
