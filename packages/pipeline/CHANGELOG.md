# storylark-pipeline

## 0.16.0

### Minor Changes

- [`348ba3b`](https://github.com/StoryLark/storylark/commit/348ba3b2ccaf14c01670186375f9bf7b1d80161d) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Add the public content API, bulk import, and the bulk narration queue — plan §8
  items 1, 3 and 4.

  **Content API (`/api/content/v1`).** A documented, versioned PUSH contract an
  external publishing system integrates against once. Until now content only
  arrived through the CLI or through the two PULL connectors; there was no stable
  way for a publisher's own release step to call StoryLark. The major version is in
  the path and in every request body (`contractVersion`, required — a missing one
  is a hard 400), following the same rule `packages/contracts/validate.mjs` applies
  to brand/presentation/deployment files: additive fields never move it, unknown
  request fields are ignored rather than rejected. Auth is `X-Admin-Key` with an
  admin session as the second door, matching `POST /api/admin/publish`. Content
  pushed here is `origin: sync` with `syncSource.kind: "api"` by default, so the
  portal shows it read-only and names the pushing system — plan §8's ownership rule
  applied to the third arrival route — and `managed: false` opts out. The API in
  turn refuses to overwrite a book a PULL connector owns, because the next sync
  would revert the push. Every write lands in the same `saveChapter()` the portal's
  editor calls; there is no second content model and no second write path. Full
  integrator documentation in `docs/content-api.md`.

  **Bulk import.** `POST /api/content/v1/books` takes an array; `POST
/api/content/v1/import` takes a zip of the ordinary markdown-folder layout,
  unpacked with the dependency-free zip codec already in `storylark-contracts` so
  it works inside a Worker. Both run through the same `pushBooks()`, with an
  explicit, documented failure policy: `best-effort` (the default) reports per
  item and answers `207` when part of a batch fails, so one malformed book in fifty
  costs that book and not the other forty-nine; `all-or-nothing` validates
  everything before writing anything and is honest that object storage has no
  transaction, so a storage failure mid-batch is reported per book rather than
  claimed to have rolled back. Archive entries that are not books come back in an
  `ignored` list with a reason each.

  **Bulk narration queue.** New `narration_jobs` / `narration_batches` tables
  (migration 0008, both dialects), a queue engine, `/api/admin/narration/*`, a
  portal card, and `packages/pipeline/narrate.mjs` — a real worker that claims
  jobs, synthesises with the same `synthesizeChapter`/`stitchChapter` `publish.mjs`
  uses, uploads to the same content-hashed keys, and reports back so the deployment
  updates its own manifest and clears `audioStale`. Portal saves, reverts and every
  API push enqueue automatically, idempotently per chapter. Progress carries a time
  estimate measured from this deployment's own completed jobs, and is `null` — with
  that stated — until something has actually completed. Claims are atomic, stale
  claims are reclaimed after 30 minutes, and a completion whose content hash no
  longer matches the live chapter is refused rather than published against words it
  does not match. Batch completion emails the operator once, following the existing
  `update-check` notification pattern; it is deliberately not a reader push, since
  narration is never an announcement.

  The queue is honest about the platform split rather than hiding it: **no**
  deployment can narrate — a Worker cannot run the model at all, and the Node entry
  ships no TTS dependency — so `GET /api/admin/narration` returns
  `runtime.canProcessInDeployment` with the platform's own reason and the command
  that does the work, and the portal renders those rather than a hard-coded
  sentence. Documented in `docs/narration-queue.md`.

  Also closes the verification gap AB#7422 recorded: the `409 managed_externally`
  enforcement is now proven at the HTTP level on the Node/Azure stack — a real
  PostgreSQL server, the real shipped `migrate-postgres.mjs`, the real
  `postgresDatabase()` driver and a real socket — in
  `packages/worker/test/node-http-readonly.test.mjs`.

- [`0522fa9`](https://github.com/StoryLark/storylark/commit/0522fa923b2d60989fe4041fb671abcb7c8c3b4d) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Per-block re-narration, chapter reorder, and conflict detection between a
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
  the manifest already _is_ the chapter order, so there is no new position field;
  the route takes the whole order and verifies it is a permutation of what the
  manifest holds, so a browser tab left open through a publish cannot delete a
  chapter by omitting it. Never announced — rearranging a table of contents is
  not new writing.

  **Conflict detection, both directions.** `publish.mjs` now reads the live
  manifest _before_ it uploads anything and refuses — exit 2, naming each chapter
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

## 0.13.0

### Minor Changes

- [`142ab1e`](https://github.com/StoryLark/storylark/commit/142ab1ec1d9d83a903305d68c95fc77b04395e99) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Content can come from somewhere else, and then it isn't ours to edit (AB#7422, AB#7426)

  The portal assumed StoryLark was the system of record. A publisher who already
  has a website repository or a content system is not going to re-author their
  catalogue in it, and will not accept two divergent copies of the truth. So
  content now records **where it came from**, and one rule follows from it:
  _whoever owns the content owns the edit button._

  **`origin` on every book and chapter** — `portal`, `cli`, `sync` or `personal`.
  An absent value reads as `cli`, so every library published before this field
  existed keeps working and stays fully editable; nothing becomes read-only by
  omission. `personal` is the seam a reader's own device-local imports will arrive
  through, and is not otherwise built.

  **Two pull connectors, and no bespoke ones ever** —
  `packages/pipeline/sync.mjs --brand <id>` pulls a library from either a **git
  repository of markdown** (a real shallow `git clone`, so any host works with no
  per-host code; private repos via `STORYLARK_SYNC_TOKEN`) or the publisher's own
  system over a **small documented JSON feed**. It stages the result in the blessed
  folder-per-book layout and then runs `publish.mjs` over it — so change detection,
  narration, force-alignment, upload, manifest-written-last and push notification
  are the pipeline that already existed, not a second copy of it. A third `kind` is
  rejected with a pointer at the content API: "we'll write a connector for your
  CMS" is the one commitment here that could never be finished.

  **Pipeline** — `--origin` and `--sync-kind/-url/-ref/-path`; a republish preserves
  whatever origin is already live rather than relabelling it, so a synced library
  that gets its narration from an ordinary `publish` run stays synced. **A publish
  now only removes books it could have produced**: a sync no longer deletes
  portal-written stories from the manifest, a CLI publish no longer deletes the
  synced catalogue, and `--book <id>` narrows the publish rather than the library.
  The library version is also seeded from a `--local` directory's existing
  manifest, so two publishes into one directory can't both claim v1.

  **Worker** — the admin content API refuses every write against `origin: sync`
  with `409 managed_externally` and a message naming the actual source, while
  leaving reads, downloads and history alone. `portal` and `cli` content is
  untouched. The listing and chapter detail now carry `origin`, `readOnly` and
  `syncSource`.

  **Portal** — synced rows are badged, and a synced chapter opens as a read-only
  view with a _Managed externally — edit at source_ notice and a link, instead of
  an editor whose save button would be refused.

  Configuration lives in `deployment/<id>/deployment.json` (`sync.kind`/`url`/`ref`/
  `path`, schema-validated) or `STORYLARK_SYNC_*`. The credential is environment
  only — a token in the committed file is a hard error. Scheduling runs where
  publishing runs; scaffolded sites now get a `sync.yml` workflow (nightly cron
  plus a manual button) alongside `publish.yml`. Full guide: `docs/content-sync.md`.

  Also fixed while adding `sync.mjs` to the package: `storylark-pipeline` was not
  shipping `storage.mjs` or `storage-azure.mjs`, so `publish.mjs` in the published
  tarball crashed on its own storage seam.

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
