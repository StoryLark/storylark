# storylark-worker

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

## 0.15.5

### Patch Changes

- [`80e8d37`](https://github.com/StoryLark/storylark/commit/80e8d372b2f6b4cb43c6225d832050fe00c0a926) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Add `./migrate-postgres.mjs` to the package's `exports` map. It was
  already listed in `files` (so it shipped in the published tarball) but
  missing from `exports` — Node's strict exports-map resolution rejects
  any subpath not explicitly listed there regardless of `files`, so
  `self-deploy.mjs`'s `createRequire(...).resolve('storylark-worker/
migrate-postgres.mjs')` threw `ERR_PACKAGE_PATH_NOT_EXPORTED` and every
  real Azure one-click update failed at the migration step with a false
  "file is missing" error. `install.mjs`'s own layer-2 update path never
  hit this — it joins the path directly instead of asking Node's module
  resolver — which is why this went unnoticed until the one-click path
  was exercised for real. Adds a regression test.

## 0.15.4

### Patch Changes

- [`108c6f5`](https://github.com/StoryLark/storylark/commit/108c6f574ebf6f3eb71a470c03dd229f726c5d25) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Fix the real cause of the 404 diagnosed in the previous patch: Azure's
  `server.mjs` sets `ENGINE_RELEASE_REPO` to `process.env.ENGINE_RELEASE_REPO
?? ''` — an empty string when unset, not `undefined`, since Node env vars
  don't distinguish "absent" the way a Cloudflare Workers binding does.
  `findEngineRelease()` resolved its default repo with `??`, which only
  falls back on `null`/`undefined`, so the empty string reached it unchanged
  and built `https://github.com//releases/...` — a real 404, but from a
  malformed URL, not a missing release. Switched to a truthy check (`||`),
  matching how `ENGINE_RELEASE_BASE` was already handled two lines above.
  Removes the temporary diagnostic message from the previous patch now that
  the cause is confirmed; adds a regression test.

## 0.15.3

### Patch Changes

- [`35753dc`](https://github.com/StoryLark/storylark/commit/35753dc23fb611dec0816e863756737f0dd83263) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Temporary diagnostic: when the engine artifact checksum fetch 404s,
  include the URL actually landed on (post-redirect) and a body snippet in
  the error message. Azure App Service is returning a real 404 for a
  release confirmed reachable from every other network tested this
  session — this narrows down where in the redirect chain it's failing
  without needing remote access to the box. Remove once understood.

## 0.15.2

### Patch Changes

- [`547eff7`](https://github.com/StoryLark/storylark/commit/547eff70a56510e9c1659681c4adbeb2cfaf7f7a) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Fix `POST /api/admin/update-install`'s default version resolution: it asked
  the npm registry for `storylark-worker`'s latest version and used that
  number to locate the GitHub release, but the release (and its prebuilt
  engine artifact) is tagged by `storylark-core`'s version. The two now
  diverge whenever a changeset only bumps the worker (as this repo's own
  self-deploy fixes just did) — the admin portal's "Install update" button
  always POSTs an empty body, so this was the only path it took, and it
  404'd looking for a release that was never going to exist. Found live
  against Azure dev while verifying the one-click mechanism end to end.

## 0.15.1

### Patch Changes

- Fix three real bugs in the Phase 5 one-click update mechanism, found only
  by actually triggering it against a live Cloudflare deployment:

  - `findEngineRelease` no longer calls `api.github.com` (rate-limited per
    source IP, which a Cloudflare Worker's shared outbound IP pool hits in
    practice) — it constructs GitHub's direct release-download URL instead.
  - The Cloudflare self-deploy swap now uses the plain script endpoint
    (`PUT .../scripts/:name`), not `/content`, which does not exist for an
    asset-backed Worker.
  - Non-secret bindings are read back and resupplied on the swap (the plain
    endpoint replaces the whole config); `secret_text` bindings are omitted
    entirely rather than referenced, since Cloudflare preserves omitted
    secrets automatically and rejects a referenced-with-no-value binding.

## 0.15.0

### Minor Changes

- [`42e434a`](https://github.com/StoryLark/storylark/commit/42e434a08bf8b0f28d033bff1195c4a8ad67b131) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - A prebuilt engine, and a button that installs it (AB#7418 — plan §4 layer 3, §0d Phase 5)

  Every release now publishes `storylark-engine-<version>.zip` alongside a `.sha256`,
  attached to the GitHub Release changesets already cuts. It is the whole engine and
  **none** of anyone's brand: `vite build --mode engine` resolves brand, presentation
  and deployment config to empty, so the same bytes are correct for every deployment
  on a given version. `npm run package-engine` refuses to package a build that carries
  brand data — it scans every output byte against every brand in the repo — and CI runs
  that check before the release publishes, so a regression breaks the release rather
  than shipping one customer's identity to everyone else.

  With that, `/admin` can offer an **Install update** button: download the prebuilt
  engine, verify its published checksum and its own per-file digests, apply the
  migrations that shipped with it, and redeploy through the platform the site already
  runs on. No build runs anywhere, and GitHub is a file host rather than a build
  service.

  It is **off by default and opt-in per deployment.** Without it, `/update-status`
  reports `oneClick.available: false` with a reason and the portal shows exactly the
  installer command it shows today. Turn it on with `install.mjs --enable-one-click
--yes`: on Cloudflare that stores a Workers-Scripts-scoped API token _you_ issued as
  a Worker secret; **on Azure it stores nothing at all** — App Service's managed
  identity plus a Website Contributor role on that one site is enough for Kudu, which
  is a better answer than the plan's own wording assumed. `--disable-one-click`
  reverses either.

  The route is session-only — no `ADMIN_KEY` door — because the click is the approval.
  Brand files are excluded from the artifact by the format itself and re-uploaded from
  the deployment's own assets as part of the deploy, so an update cannot overwrite an
  identity, a theme or an icon. On Cloudflare it uses the "put script content"
  endpoint, which leaves bindings, vars, secrets, routes and cron triggers alone.

  Also: builds emit `dist/outputs.json` (an inventory with brand-owned files marked,
  which is how the updater knows which of your files to carry across), icons moved out
  of the service-worker precache into stale-while-revalidate — a precached icon pinned
  an installed PWA to the pictures it was installed with, which Phase 4's theme import
  had already made wrong — and `migrate-postgres.mjs` gained `--dir` so the in-portal
  update runs the artifact's own migration set through the same script the installer
  uses rather than a second implementation.

### Patch Changes

- Updated dependencies [[`42e434a`](https://github.com/StoryLark/storylark/commit/42e434a08bf8b0f28d033bff1195c4a8ad67b131)]:
  - storylark-contracts@0.3.0

## 0.14.0

### Minor Changes

- [`a2eed22`](https://github.com/StoryLark/storylark/commit/a2eed220c5f08ed2f9b98dd46518b38cefff9ac8) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Theme packages: install a brand from a zip, from the portal or the CLI, with versions and one-click rollback (AB#7417 — plan §0c / §0d Phase 4)

  Phases 2 and 3 made brand, stylesheet and presentation into files the deployment
  serves and re-reads per request, so swapping one changes a live site with no
  rebuild. This is the piece that let anyone actually perform the swap — on
  Cloudflare there was no filesystem to swap files on at all.

  **The format** is what a brand folder already is: `<id>.storylark-theme.zip`
  holding `package.json`, `brand.json`, `theme.css`, `icons/` and optionally
  `presentation.json`.

  **The tool's value is validation, not zipping.** `npm run package-theme` refuses
  to emit a package the deployment would refuse to install, using the same module
  the deployment uses — missing or wrongly-sized icons, missing design tokens, a
  dark-first theme with a dark alternate block, an unknown `contractVersion`. Output
  is deterministic, so packaging an unchanged brand produces an unchanged file.

  **Two doors, one implementation.** `npm run import-theme` posts the same zip to
  the same `POST /api/admin/themes/import` the portal's upload button posts to —
  authenticated by an admin session or the `ADMIN_KEY` the publish pipeline already
  uses. Also: `--check`, `--list`, `--rollback previous`, `--revert`.

  **An installed theme lives in the deployment's own storage**, on the same seam
  content editing already binds on both platforms; the build's assets stay the
  fallback, so an engine update cannot change how an existing site looks until
  somebody imports something. Validation happens before any write, and `active.json`
  is written last, so a package that fails is a pure no-op — the endpoint answers
  `422` with every problem found and `applied: false`.

  **Versions and rollback**: the last five (`THEME_VERSIONS` overrides), the live
  one never aged out, rollback restoring exactly the bytes that were installed.

  **The portal gets a Brand & themes card** — install, check-first, version history,
  one-click rollback, download any version, revert to the built-in brand, and a
  brand form for changing a colour or a font without a package at all. A form edit
  is a version like any other, so it can be downloaded as a package and moved to
  another deployment.

  `storylark-contracts` is a new zero-dependency package holding the three JSON
  Schemas, their validator, the theme package format and a dependency-free zip
  codec — because the import endpoint validates inside the Worker, which can import
  neither a frontend package nor a second copy of the rules. `storylark-core/schemas`
  re-exports all of it, so every existing import path is unchanged.

  Cloudflare's `run_worker_first` loses its `!/icons/*` exclusion, so an imported
  package's icons can be served at all.

### Patch Changes

- Updated dependencies [[`a2eed22`](https://github.com/StoryLark/storylark/commit/a2eed220c5f08ed2f9b98dd46518b38cefff9ac8)]:
  - storylark-contracts@0.2.0

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

### Patch Changes

- [`e23d94c`](https://github.com/StoryLark/storylark/commit/e23d94cb74a122cf6202c5909f0e46a54002e9ce) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Fix the Postgres driver returning COUNT(\*)/bigint columns as strings instead
  of numbers, a real cross-platform response-shape divergence (confirmed live:
  Azure's `/api/admin/status` reported `pushSubscriptions` as `"0"` while
  Cloudflare reported `0`, same brand, same data). Registers a `pg` type
  parser for bigint (OID 20) once, so every count/bigint column now returns a
  plain number on Postgres, matching D1/SQLite's native behavior.

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

## 0.11.0

### Minor Changes

- [`6591312`](https://github.com/StoryLark/storylark/commit/6591312449212bc22a446ebf5f7d83fae022d388) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - How your library is arranged is data your deployment serves, not code it was built from (AB#7416).

  Reordering two tabs meant a rebuild of the whole engine on somebody's laptop and
  a redeploy, because the tab bar, the Home sections, the shelf's sorting and every
  other structural choice were hardcoded in a component or compiled into the
  bundle. `presentation.json` now ships as a real file in the built output, and the
  platform serving your site reads it on the way out of every request:

  ```
  index.html / admin.html   <script id="storylark-presentation">self.__STORYLARK_PRESENTATION__={…}</script>
  sw.js                     the same assignment, as a prelude
  ```

  Replace `dist/presentation.json` on a deployed site and the live site rearranges
  — no recompile, no new hashed chunk, and on the Azure Node server not even a
  restart.

  **The §0b contract, implemented.** `nav` (position, which entries, their order,
  their labels), `home.sections`, `library` (default sort, which sorts and
  groupings the picker offers, list or grid, search), `reader.defaultMode`,
  `player` (skip distance, speed dial), `cover.aspect`, `detail` (which of cover /
  author / description / chapter list / length appear), `auth.required`,
  `settings` (which controls the Settings screen offers), `download.mode`,
  `emptyState` copy, `about.links`, and `features` for everything core ships next.

  **Two rules make a template outlive the engine it was written for.** A missing
  key takes the core default, _permanently_ — `DEFAULT_PRESENTATION` in
  `storylark-core/src/presentation.ts` is exhaustive and is the only place a
  default exists, so components read the resolved value and never invent a second
  one. An unknown key is ignored with a warning, at all three boundaries: the
  build, the serve-time injector, and the resolver. A file written for a newer
  engine loads on an older one; a file written today keeps working forever.

  **Nothing moves for an existing library.** Every default is the behaviour the app
  already had, established by reading the component rather than by taste — the same
  four tabs in the same order, the same four-entry shelf picker with the same
  labels, ±15s, portrait covers, the same empty-state strings. The three knobs that
  used to be _derived_ from `layout` — the shelf's grouping and search box, and
  what auto-download means — are now ordinary keys whose default still follows the
  layout exactly, so the coupling the plan called "surprising and undocumented" is
  stated rather than implicit, and overridable for the first time.

  - **A third global, not a key in either of the other two.** Reshaping
    `__STORYLARK_DEPLOYMENT__` or `__STORYLARK_BRAND__` would break an installed
    PWA mid-update; the three have different sources and different failure modes;
    and folding presentation into the brand would delete the identity/arrangement
    boundary two commits after it was drawn.
  - **All-or-nothing between the injected file and the build-time fallback**,
    unlike brand's per-key merge: an injected presentation _is_ this deployment's
    presentation, so a key it does not state must fall through to core's default,
    not to the copy of the same file that was on disk at build time.
  - **`layout` and `nouns` leave `Brand`.** They are presentation, they have their
    own resolver, and `NOUNS` / `countUnits()` now come from
    `storylark-core/src/presentation.ts`.
  - **Staleness closed.** The service worker re-stamps the precached shell with the
    _stated_ presentation (never the resolved one — that would bake this engine's
    defaults into a cached document and let a stale default outlive the update that
    changed it), and `presentation.json` is not precached.
  - **Everything degrades.** No `presentation.json`, unparseable JSON, one bad
    value, an older `storylark-worker`, or no server at all: the site stays up on
    the build-time fallback and core's defaults. A hand-edited file cannot take a
    library down.

## 0.10.0

### Minor Changes

- [`b4554c7`](https://github.com/StoryLark/storylark/commit/b4554c76f7bbb35d535376e95e59740047ff23cf) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Your brand is data your deployment serves, not code it was built from (AB#7415).

  Changing a tagline meant a rebuild of the whole engine on somebody's laptop and
  a redeploy, because names, colours, the default theme and font choices were
  compiled into the JS bundle. They are not any more. `brand.json` and `theme.css`
  ship as real files in the built output, and the platform serving your site reads
  them on the way out of every request:

  ```
  index.html / admin.html   <script id="storylark-brand">self.__STORYLARK_BRAND__={…}</script>
                            plus <title>, rewritten from the live brand
  sw.js                     the same assignment, as a prelude
  /theme.css                your stylesheet, with the live font selection appended
  /manifest.webmanifest     generated from the live brand
  ```

  **Replace `dist/brand.json` or `dist/theme.css` on a deployed site and the next
  request serves the new brand** — no rebuild, no new JavaScript, no hashed asset
  touched. On Azure the running process re-reads the file on every request, with
  no restart; on Cloudflare, where a Worker has no filesystem, the files live in
  the deployed asset bundle and the Worker reads them through its asset binding.
  Injection rather than a fetch: the script sits in `<head>` ahead of the app
  bundle, so there is no extra round trip and no flash of the previous brand's
  name. The service worker re-stamps the brand into the precached app shell, so an
  installed PWA cannot keep serving yesterday's identity either.

  **Fonts: a curated set, selected by name.** Every build now ships the whole set —
  Newsreader, Lora, Cormorant Garamond, Cinzel, Inter, IBM Plex Mono — and `fonts`
  in `brand.json` picks which of them `--font-display`/`-headers`/`-body`/`-mono`
  resolve to, appended to `theme.css` when it is served. So switching typeface is a
  file edit, not a rebuild. A family outside the set is ignored with a warning and
  your theme's own `--font-*` value stands; uploading a custom font is a later
  phase. Unused families cost nothing over the wire — a browser fetches a font
  file only when something renders in it — and fonts are cached on first use
  rather than precached, which makes the offline install smaller than before.

  **`theme.css` is no longer bundled.** It is `dist/theme.css`, linked from the
  document. If your site imported `virtual:storylark-theme.css` anywhere, drop the
  import; the virtual module is gone and the stylesheet is served instead.

  **Cloudflare sites: `run_worker_first` changes again.** `!/manifest.webmanifest`
  is removed — it was `["/*", "!/assets/*", "!/icons/*", "!/manifest.webmanifest"]`
  and is now `["/*", "!/assets/*", "!/icons/*"]` — so the manifest is generated
  from your live brand instead of served as the file your last build wrote. Update
  your `wrangler.jsonc`; `npm create storylark` writes the new form. `/theme.css`
  and the manifest now cost a Worker invocation; `/assets/*` and `/icons/*` still
  do not.

  **Azure sites: update `storylark-worker` too.** The Node entry imports
  `storylark-worker/lib/brand`; an older worker package degrades to the brand baked
  in at build with a warning at boot rather than failing to start, so the order of
  the two updates does not matter, but the brand will not be swappable until both
  have landed.

  **Two caveats worth knowing before you change a live brand.** An already-installed
  PWA can keep its old home-screen name and icon until it is reinstalled — the OS
  owns that copy of the manifest, and that is outside any web app's control.
  And icon _files_ are still files: the manifest follows `brand.json`, but the
  pictures change only when you replace `dist/icons/*`. See
  `docs/build-your-own-theme.md` for the full list.

## 0.9.0

### Minor Changes

- [`3c62506`](https://github.com/StoryLark/storylark/commit/3c6250617ac0d798a6f4fcc43cb7191225e38946) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Deployment config comes from the running deployment, not from the last build (AB#7414).

  Change `CONTENT_ORIGIN` in your Azure app settings or your Worker vars and the
  API picked it up on the next request — but the frontend did not, because
  `appOrigin`, `contentOrigin`, `vapidPublicKey` and `tts` were compiled into the
  JS bundle. The two halves of one deployment disagreed until somebody rebuilt
  and redeployed the site. They no longer can: the platform serving the documents
  stamps its own current environment into them on the way out.

  ```
  index.html / admin.html   <script id="storylark-deployment">self.__STORYLARK_DEPLOYMENT__={…}</script>
  sw.js                     the same assignment, as a prelude
  ```

  No extra round trip and no flash of a wrongly-configured UI — the script sits in
  `<head>`, ahead of the app bundle, so the values are there before the first line
  of app code runs. The service worker gets its own copy because it needs the
  content origin synchronously inside its fetch handler, and it re-stamps the
  precached app shell so an installed PWA cannot keep serving yesterday's origins
  either.

  `deployment/<id>/deployment.json` and the `STORYLARK_*` build overrides are now
  the **fallback**, per key: they are what a build carries for contexts nothing
  injects into (`vite dev`, `vite preview`, plain static hosting), and an unset
  environment variable leaves the built-in value alone rather than blanking it. A
  live value that is not a valid origin is ignored with a warning in the platform
  log rather than shipped to readers.

  **Cloudflare sites: `run_worker_first` changes.** It was `["/api/*"]`; it is now
  `["/*", "!/assets/*", "!/icons/*", "!/manifest.webmanifest"]`, so navigations,
  `/admin` and `/sw.js` reach the Worker and can be injected into. The Worker
  serves them via `env.ASSETS.fetch()`, so `/admin` → `admin.html`, the `/admin/`
  and `/admin.html` 307s, and the SPA fallback all still come from the asset
  router unchanged. Hashed assets and icons still cost no Worker invocation.
  Update your `wrangler.jsonc` when you update — `npm create storylark` writes the
  new form.

  **Brand config no longer carries addresses.** `Brand` (`virtual:storylark-config`)
  lost `appOrigin`, `contentOrigin`, `vapidPublicKey` and `tts`; they are
  `DeploymentConfig`, exported from `storylark-core` as `DEPLOYMENT`. Anything
  reading `BRAND.contentOrigin` should read `DEPLOYMENT.contentOrigin`. Identity
  and infrastructure are separate objects with separate lifetimes, which is the
  point.

- [`c59955f`](https://github.com/StoryLark/storylark/commit/c59955fbdb3b0a6cc50da391212df6416e072931) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Platform updates no longer need a GitHub token, or any stored credential
  (AB#7403).

  A deployed reading app has no business holding a credential that can deploy on
  its owner's behalf. The "Install update" button and its
  `POST /api/admin/update-install` route — which dispatched a `self-update.yml`
  GitHub Actions workflow and therefore required `GITHUB_REPO` +
  `GITHUB_DEPLOY_TOKEN` on the deployment — are removed, along with the workflow
  template.

  What replaces them:

  - **Detect** (unchanged): the daily check and `GET /api/admin/update-status`
    still compare the running engine version against the public npm registry,
    unauthenticated and read-only.
  - **Update**: `node platforms/<platform>/install.mjs --update --yes`, run by
    the operator from the machine they deploy from. It bumps the pinned engine
    version, installs, migrates, rebuilds with the brand untouched, and
    redeploys — authenticating with the operator's existing `wrangler login` /
    `az login`. It provisions nothing, edits no config, and stores no secret, so
    it is safe to re-run at any time.

  `GET /api/admin/update-status` drops `selfUpdateConfigured` and gains
  `platform` (detected from the runtime), `updateCommand` (the exact command to
  run), and `updateDocsUrl`. The admin portal's Platform update card now shows
  that command, with a copy button, instead of an install button.

  `GITHUB_REPO` / `GITHUB_DEPLOY_TOKEN` remain optional and are now used by the
  admin portal's story upload only.

## 0.8.0

### Minor Changes

- [`afddda2`](https://github.com/StoryLark/storylark/commit/afddda2af670a2201334b5e3c0461dd198d63d95) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Admin portal auth moves from a shared `ADMIN_KEY` header to database-backed
  accounts (AB#7404).

  `/admin` is now gated by a normal account in the app's own `users` table
  carrying a new `is_admin` flag — same email+password, same session cookie,
  and same emailed password reset any reader gets. The portal no longer asks
  for, stores, or sends an admin key.

  Getting the first account, and getting back in:

  - The installer prints a one-time setup link plus ten recovery codes at the
    end of a successful deploy.
  - Three recovery doors: the ordinary forgot-password email (works on admin
    accounts with no special-casing), a printed recovery code, or — last
    resort — re-minting a setup link with the deployment's `ADMIN_KEY`.

  New routes: `POST /api/admin/setup/reset`, `POST /api/admin/setup/claim`,
  `POST /api/admin/recover`. `GET /api/auth/me` now returns `isAdmin`.

  Migration `0007_admin_accounts.sql` (both dialect trees) adds `users.is_admin`
  plus the `admin_setup_tokens` and `admin_recovery_codes` tables.

  **Breaking:** `GET /api/admin/status`, `GET /api/admin/update-status`,
  `POST /api/admin/update-install`, and `POST /api/admin/publish-story` no
  longer accept an `x-admin-key` header — they require an admin session.
  `POST /api/admin/publish` still accepts the key, because the publish
  pipeline calls it headless from CI, and `POST /api/admin/setup` still does
  too, because it runs before any account can exist.

## 0.7.1

### Patch Changes

- Publish `migrate-postgres.mjs` and `migrations-postgres/` as part of the package. Previously only `migrations/` (D1) shipped, so a standalone Azure/Postgres deployment outside the engine monorepo had no way to actually apply its database schema — the migration script existed only in the engine repo's own source tree.

## 0.7.0

### Minor Changes

- [`2f3bac8`](https://github.com/StoryLark/storylark/commit/2f3bac8eeac6ef025be2bff9b4f0d963096a2001) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Self-update and admin portal (AB#7403, AB#7404). A new `/admin` screen
  (admin-key gated, key held in localStorage) shows the running engine
  version against the latest published release, with an "Install update"
  button that dispatches the site's own `self-update.yml` GitHub Actions
  workflow — the click is the approval; nothing updates without it, and the
  updater can only ever touch pinned engine versions, never a brand's theme
  or presentation config. The portal also has a status view (library size,
  push subscriber count) and a text story-upload form that commits markdown
  via the GitHub Contents API and dispatches `publish.yml`, running the
  real, unchanged publish pipeline rather than a second copy of its logic.

  New worker routes: `GET /api/admin/status`, `GET /api/admin/update-status`,
  `POST /api/admin/update-install`, `POST /api/admin/publish-story`. A
  scheduled check (Cloudflare Cron Trigger / Azure interval) can also email
  the operator proactively when RESEND_API_KEY and ADMIN_EMAIL are set — all
  optional, everything degrades cleanly without these secrets configured.

## 0.6.0

### Minor Changes

- [`ccb4899`](https://github.com/StoryLark/storylark/commit/ccb489966335099c7f176c14934443885fed9b40) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Database access now goes through a platform-agnostic Database interface
  (`Database` + `ConflictInsert` in `src/db/types.ts`) instead of directly
  against Cloudflare D1. The Cloudflare driver (`src/db/d1.ts`) is a zero-cost
  identity wrapper — no behavior change for existing D1 deployments. A new
  Postgres driver (`src/db/postgres.ts`) covers Azure Database for PostgreSQL
  and AWS RDS/Aurora with one implementation, translating `?` placeholders
  positionally and using `citext` for case-insensitive email/username lookups.

  The three `INSERT OR IGNORE` call sites move to a portable `insertIgnore()`
  helper — the only genuinely dialect-specific SQL, implemented once per
  driver.

  The package now also exports a raw `app` (the Hono instance with no
  Cloudflare-specific wrapping) alongside the existing Cloudflare-only default
  export, for platform entries that bind `env.DB` to a driver directly
  (`platforms/azure/server.mjs`).

  Migrations gained a Postgres-dialect mirror: `migrations-postgres/*.sql` plus
  `migrate-postgres.mjs`, the Postgres equivalent of
  `wrangler d1 migrations apply`.

## 0.4.0

### Patch Changes

- [`95e38e0`](https://github.com/StoryLark/storylark/commit/95e38e00711cb3ffb8f86dad44777c1426d34e16) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Traceable build identity. The app version shown in Settings/About is now storylark-core's real npm version (the hand-bumped APP_VERSION counter is gone), and About gains a "Version & build" section listing the version of every installed storylark-\* package plus the solution build's git commit, build time, and brand. The Vite preset injects this at build time via `virtual:storylark-build`. RELEASE-NOTES.md headings are now keyed to the same version number. worker/pipeline: expose `./package.json` in exports so build tooling can read their versions.

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
