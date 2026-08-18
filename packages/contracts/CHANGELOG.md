# storylark-contracts

## 0.5.1

### Patch Changes

- [#12](https://github.com/StoryLark/storylark/pull/12) [`b8f2754`](https://github.com/StoryLark/storylark/commit/b8f27549307a784727349196c76e10e66d2f54b8) Thanks [@hcs-platform-app](https://github.com/apps/hcs-platform-app)! - Make npm-create the safe publisher default: install and lock all three
  StoryLark packages, record project provenance, verify before deployment, and
  ship read-only local/live diagnostics. Support existing Cloudflare resource
  names without changing brand identity.

  Treat repository validation as an atomic gate, report duplicate book
  declarations, and preserve narration/timing/voice metadata on no-op syncs.
  Add explicit matching-only adoption for existing live libraries: complete
  chapter, rendered-content, metadata, order, and cover parity is required before
  ownership can move to repo sync, while narration and content objects remain
  untouched. Read GitHub repositories path-first, batch authenticated Markdown
  reads to stay within the Workers Free subrequest budget, preserve legacy
  single-story chapter ids, and keep root-relative artwork hash-compatible with
  the publish pipeline.
  Update demo content and deployment documentation for both standalone stories
  and multi-chapter books, and move Sharp to its patched release.

## 0.5.0

### Minor Changes

- [`5db49fd`](https://github.com/StoryLark/storylark/commit/5db49fd67bfdbec51c22cfccf37827a7ed93971f) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - ONE content gate for every transport, plus portal book lifecycle (AB#7420 —
  content-management rework, wave 1).

  - **contracts**: new `storylark-contracts/content` — the single content
    validator every transport calls. It reads the namespaced, additive
    `storylark:` frontmatter block (`type` / `book` / `chapter` / `order` /
    `publish` / `title` / `cover` / `contractVersion`), validates strictly
    (no inference, no repair: missing required fields, bad ids, non-integer or
    tied `order`, URLs as covers are all errors with stable codes, messages and
    line numbers), and normalises with the spec defaults (`publish: true`,
    `contractVersion: 1`). `requireBlock` enforces the repo rule — a file
    without a `storylark:` block is not StoryLark content — while portal/API
    candidates carry transport identity, which is what keeps every pre-block
    chapter in existing deployments valid.
  - **worker**: the public content API and the portal's admin content routes both
    validate through the shared gate. Rejections carry the gate's structured
    `errors` list; the top-level `error` code is now the gate's specific stable
    code (e.g. `unclosed_frontmatter`) instead of the old umbrella
    `invalid_markdown`. `storylark.publish: false` is withheld — accepted,
    reported (`withheld`, `summary.chaptersWithheld`), nothing written — and
    `storylark.title` overrides the top-level title on save. When every chapter
    in a push declares `storylark.order`, that order decides the book's chapter
    order; ties reject the book without costing the rest of the batch.
  - **core**: the portal can finally create and delete books/stories. "New
    book"/"New story" (id, title, author, description, cover) and typed-
    confirmation "Delete" call the existing public `/api/content/v1` routes
    authenticated by the admin session — one implementation, two credentials,
    the same discipline theme import uses. Created books are `managed: false`
    (portal-owned, editable); a new story opens straight into the editor.

  Pre-contract content is untouched: markdown without a `storylark:` block keeps
  saving, syncing and rendering exactly as before.

- [`8f4a564`](https://github.com/StoryLark/storylark/commit/8f4a56463f850a9934e70a7907c643fe89250d54) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - The repo transport, sync triggers, per-book presentation and scoped
  content-API tokens (AB#7420 — content-management rework, wave 2).

  - **contracts**: the vocabulary gains the two manifest-context codes —
    `unknown_book` (a chapter naming a book neither held nor declared by the
    same arrival; arrivals are evaluated as a SET, so a `type: book` file
    anywhere in the batch satisfies the reference) and `book_owned_elsewhere`
    (the first writer owns a `bookId`; a different source is rejected with the
    owner named). The stored manifest now joins the `order_tie` check
    (`existingChapters`): an order an incumbent declared last month collides
    exactly as one declared in the same batch, same code, same message —
    re-declaring the order a chapter already owns is not a tie. Transport-
    supplied ids are validated by the gate itself, `type: book` must name its
    book in repo mode, and `isRepoCandidate` settles candidacy so a broken
    frontmatter fence that mentions `storylark:` is rejected rather than
    silently ignored.
  - **worker**: a deployment now syncs a git repository itself. The repo
    transport fetches the provider's archive over HTTPS (a Worker cannot shell
    to `git`), unpacks it with the existing zip reader, walks the configured
    path and hands every candidate to the one gate — no validation of its own,
    no inference. Three trigger tiers: a signature-verified webhook
    (`POST /api/content/v1/sync/webhook` — unsigned or forged deliveries are
    rejected), a daily pull as a second job on the EXISTING update-check cron
    (schedule unchanged; the interval gates per connection), and Sync now, with
    concurrent runs collapsed. A chapter present in the manifest and absent
    from the arrival is reported `missing` and NEVER auto-deleted; removal is
    the operator's one click, running the ordinary recoverable delete. Images
    are ingested with the portal upload's exact allowlist (SVG refused) and
    references rewritten to the deployment's own copies. GitHub ships first,
    behind a two-function provider seam (archive URL + webhook verify), so the
    next provider is a driver, not a refactor. Migration 0009 adds the
    connection state and `content_api_tokens`; scoped bearer tokens
    (`Authorization: Bearer sct_…`) authenticate the content API and nothing
    else, individually revocable with last-used visibility. Books gain the
    derived `single` presentation flag, recomputed on every chapter-set write.
  - **core**: the Connections section — the three-way content-source choice
    (portal / repo / CMS-API; a primary source, never a lock), the repo
    connection form (SSH declined in words, dry-run gate: a repo that does not
    validate cannot be connected), sync status and report with the missing
    list, webhook secret shown exactly once, and content-API token management.
    A mixed library renders per book: a `single` book opens straight into its
    text, a multi-chapter book keeps its chapter list, whatever the
    library-wide layout says; manifests without the flag behave exactly as
    before.

  Pre-strict content is untouched: existing deployments' chapters keep saving,
  syncing and rendering exactly as they did, and `deployment.json`'s legacy
  `sync` block keeps working (`contentSource.repo` supersedes it when present).

### Patch Changes

- [`972d37e`](https://github.com/StoryLark/storylark/commit/972d37e4b7b61860f4f76dfe0c61c05f41b10c4c) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - CONTENT_ORIGIN is now optional: content serves same-origin by default (AB#7395).

  A brand-new Cloudflare deployment no longer needs an R2 custom domain — or any
  DNS work — before content loads. With `contentOrigin` unset (`""`, the scaffold
  default), `contentUrl()` builds root-relative URLs and the Worker answers
  `GET /manifest.json` and `GET /books/*` straight out of the CONTENT R2 bucket,
  with native Range/conditional support and the same cache-control the publish
  pipeline wrote each object with (manifest `max-age=60`, hashed objects
  immutable). Only those two public prefixes are exposed — theme state in the
  bucket is not.

  - Worker: same-origin content routes in `index.ts`; `CONTENT_ORIGIN`/`CONTENT`
    are optional in `Env`; `/api/admin/status` counts books from the bound store
    instead of fetching the content origin; narration claims fall back to
    `APP_ORIGIN` for `contentUrl`; portal upload/list URLs are root-relative when
    same-origin.
  - Core: the service worker recognises same-origin content requests
    (`/manifest.json`, `/books/*`) so offline downloads and content caching work
    with `contentOrigin: ""`; the admin cover thumbnail renders with a
    root-relative URL.
  - create-storylark: `CONTENT_ORIGIN` removed from the Cloudflare installer's
    required values (blank = same-origin); the wizard prompt says leaving it
    blank needs no DNS setup; the scaffold's `wrangler.jsonc` defaults it to
    `""`.
  - contracts: `deployment.schema.json` documents `contentOrigin: ""` as
    same-origin.

  Deployments with a real `CONTENT_ORIGIN` (e.g. an R2 custom domain) are
  unchanged — a separate content domain remains supported and still lets content
  bypass the Worker entirely.

## 0.4.0

### Minor Changes

- [`267dd3a`](https://github.com/StoryLark/storylark/commit/267dd3a8e07a4c42d81820bd6708ad07a76695c5) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Readers can choose one of the gallery's sample themes, and an admin can force
  one (AB#7412).

  The Settings screen's Theme control offered light, dark, and "brand default" —
  three views of one stylesheet. It now offers the five looks this engine already
  ships (Daybreak, Loveletter, Nebula, Weatherglass, Wireless) alongside the
  library's own, with light and dark still working inside whichever one is
  active.

  This is deliberately NOT the existing "one imported brand per deployment"
  system, and the two do not touch. A look is the CSS custom-property values —
  the colours and the font stacks — of one of the sample brands, applied as
  inline properties on `<html>` for that one reader. It never reaches the app
  name, the icons, the PWA manifest, `themes/active.json`, or any other reader.
  Switching back to the library's own look removes every property it set, so the
  deployment's `theme.css` is unopposed again. The values are flattened from the
  real `brands/*/theme.css` and a test re-parses those stylesheets and fails if a
  single token has drifted, so a designer retuning a sample brand cannot leave
  the bundle quietly disagreeing with the theme it is named after.

  The offer is a new presentation key, `readerTheme`, with `options` (which looks
  are offered — `[]` removes the picker) and `forced` (fix one for everyone).
  Forcing genuinely overrides a reader's saved preference rather than hiding the
  control while a stale value carries on applying, and it is applied before the
  first paint rather than after storage has been read, so a forced deployment
  does not flash its own palette first.

  `readerTheme` is the one presentation key whose default is not "what the app
  did before it existed": all five looks are offered out of the box, because what
  it turns on is an offer — the picker's first entry is the library's own look,
  selected — and nothing about an existing deployment changes until a reader
  changes it. `{"readerTheme": {"options": []}}` opts out, and
  `{"settings": {"theme": false}}` removes the whole control as before.

  Operators set both from the admin portal's Brand & themes card, through a new
  `PUT /api/admin/themes/presentation` that writes a normal theme version — same
  history, same one-click rollback, same downloadable package. `GET
/api/admin/themes` now also returns the installed `presentation`, so the portal
  renders from what the server holds rather than from the copy injected into the
  page when it loaded.

## 0.3.0

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

## 0.2.0

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
