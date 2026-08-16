# storylark-worker

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
