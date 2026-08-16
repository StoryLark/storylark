# storylark-pipeline

## 0.12.0

### Minor Changes

- [`537d197`](https://github.com/StoryLark/storylark/commit/537d197bae4cb9844c66a3b58427eccfbb4c93a6) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - The deployment stores its own source, so content can be edited from the portal (AB#7420, AB#7421)

  Publishing was one-way: markdown in, artifacts out, with the source never
  leaving the machine that ran it. That — not a missing textarea — is why nothing
  could be edited anywhere but there. `publish.mjs` now uploads the source
  markdown and book metadata alongside the derived artifacts
  (`books/<id>/source/…`), which makes the deployment self-describing and makes
  everything below possible.

  **Pipeline** — source upload for every chapter that has any; `--pull` to fetch
  deployment-side edits back into your working tree before publishing; `--no-source`
  to opt out; the library version is now seeded from the live manifest so a laptop
  that has fallen behind can't write a version that goes backwards; `audioStale`
  is derived from whether narration matches the current content hash.

  **Worker** — a new admin content API under `/api/admin/content/*` plus
  `POST /api/admin/upload`, all admin-session gated: list the library, read and
  save a chapter's markdown, live preview through the same parser that publishes,
  download the current file, revision history with revert, chapter delete,
  book-level metadata, and image upload for covers and inline art. A new
  platform-agnostic `ContentStore` seam backs it — R2 on Cloudflare via the
  binding already there, Azure Blob or a local directory on the Node entry.

  **Correction vs publication** — an edit flagged as a correction delivers the new
  text to readers but does not announce it: `manifest.announceVersion` stays put
  and no push notification is sent, while `libraryVersion` and the database's
  `manifest_version` still move so the fix actually reaches people. A genuine
  publication bumps and notifies as before. `POST /api/admin/publish` takes the
  same `announce` flag, defaulting to true.

  **Core** — the admin portal gains a content manager that respects how the
  library is arranged (`layout: flat` shows stories, `series` shows books then
  chapters): a plain markdown editor with live preview, download and upload of the
  `.md`, an insert-image action that uploads and inserts the reference for you,
  five-revision history with one-click revert, and the correction toggle on save.
  The reader now caches a downloaded chapter's images alongside its text and
  audio, and the new-content badge follows `announceVersion`.

  Narration is unchanged and deliberately not part of this: a Worker cannot run
  the TTS model, so a portal edit publishes text instantly and marks the chapter
  _audio out of date_ until the pipeline catches up. The portal says so.

## 0.9.0

### Patch Changes

- [`8a19f14`](https://github.com/StoryLark/storylark/commit/8a19f1452711860b6569951a2d21364c969778d1) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Brand, presentation and deployment config are three files, not one (AB#7413).

  `brands/<id>/brand.json` used to hold your identity, your library's shape, and
  your server addresses in one place. That made a brand unportable and a
  deployment unconfigurable — it is the direct cause of the Azure deployment that
  served Cloudflare's content origin, because `contentOrigin` was baked into the
  brand both platforms share. The three concerns now have three files, three JSON
  Schemas, and a `contractVersion` each:

  ```
  brands/<id>/brand.json                identity + look  — portable
  presentation/<id>/presentation.json   layout, nouns    — portable
  deployment/<id>/deployment.json       origins, VAPID public key, tts — per install
  ```

  - **`npm run migrate-brand`** (also `npx storylark-migrate-brand`) splits an
    existing brand, backs the original up as `brand.json.pre-split.bak`, and
    prints the deployment values — including a loud warning about the VAPID
    public key, which every already-subscribed device is bound to. It is
    idempotent; re-running it is a no-op.
  - **A pre-split `brand.json` still builds**, unchanged, with a warning telling
    you to migrate. A core update never breaks a brand that worked yesterday.
  - **Schemas ship with the engine** (`storylark-core/schemas`) and are enforced
    by the build. A missing key takes the core default; an unknown key is ignored
    with a warning; only an unsupported `contractVersion` fails the build.
  - **Deployment config gained the env overrides the origins already had** —
    `STORYLARK_VAPID_PUBLIC_KEY` and `STORYLARK_TTS_VOICE` / `_RATE` /
    `_OUTPUT_FORMAT` / `_VOICES` join `STORYLARK_APP_ORIGIN` and
    `STORYLARK_CONTENT_ORIGIN`. The Cloudflare installer now passes its
    `install.env` origins to the build, as the Azure one already did.

  No behaviour change: the built bundle for an unchanged brand is byte-identical
  apart from the build timestamp. Brand and presentation are still baked at build
  time — serving them at runtime is a later phase.

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
