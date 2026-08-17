# Changelog

## 0.18.0

### Minor Changes

- [`e841ba9`](https://github.com/StoryLark/storylark/commit/e841ba9cd6fa6527ee514b7d6d8d0ed4f9f32e2f) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - "Update now" works identically on every platform, with zero setup for the
  common case (AB#7418).

  The one-click update no longer depends on the platform's deploy API for
  releases that only change the engine. Instead of redeploying the site, the
  worker downloads the prebuilt engine artifact, verifies its published
  checksum, applies pending migrations through its own DB seam (D1 or
  Postgres), and installs the files into the deployment's OWN ContentStore —
  the same storage content editing and theme packages already use — under a
  versioned prefix, then flips one `engine/active.json` pointer. The serving
  path prefers the installed engine over the build: same code on Cloudflare
  (worker `serveAsset`) and Node/Azure (`server.mjs`), no credential, no
  platform API, atomic by construction (documents and hashed bundle always
  come from the one resolved version; the previous version's assets stay
  servable for mid-update clients until history evicts them).

  - Worker: new `lib/engine-store.ts` (install / five-version history /
    rollback / clear, brand-owned paths refused at write time as well as at
    validation); `/update-install` picks the mechanism internally — engine
    store when `storylark-worker` is unchanged, the platform deployer when it
    isn't — and `/update-status` reports a single `updateNow` answer plus the
    engine version history; new `POST /engine/versions/:id/activate` and
    `DELETE /engine/active`; the daily update check now also notices
    core-only releases.
  - Core: the Platform update card is one button — "Update now" — with the
    active engine version, rollback list, and the copy-paste command kept as
    the always-working floor; `outputs.json` now records `coreVersion` so a
    deployment knows which engine its build serves.
  - Cloudflare config: `run_worker_first` is now `["/*"]` (assets must reach
    the Worker so an installed engine can answer them). Unmodified
    deployments pay an in-memory check per asset request, not a storage read.
  - Installers: self-update for API-server releases is provisioned as part of
    a normal `--deploy`/`--update` (Azure: managed identity + Website
    Contributor, no stored credential; Cloudflare: a scoped token minted with
    the installing credential where possible, disclosed fallback otherwise;
    OAuth-only logins are told plainly what still works and how to finish).
    `--disable-one-click` is sticky via `SELF_UPDATE=off` in install.env.

  The only case the portal still hands back a command: the release changes
  the API server AND the deployment has no self-deploy permission (predates
  this change, or explicitly disabled).

- [`001b55d`](https://github.com/StoryLark/storylark/commit/001b55d48914a33b7972ce02b2858112a3873716) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - "Update now" now provisions itself on Cloudflare from a plain `wrangler login`
  — the last authentication state that used to end with a printed manual step
  (AB#7418).

  The installer reads the OAuth credentials wrangler itself persists (the
  plaintext TOML, or the opt-in keyring-encrypted envelope — formats verified
  against wrangler 4.107's shipped source), tries to mint a narrow
  `Workers Scripts | Edit` API token from the session (attempted first, though
  Cloudflare's wrangler scopes are expected to refuse it), and otherwise hands
  the session to the deployment: one refresh takes ownership of its rotation
  chain, and the refresh token lands as the `CF_OAUTH_REFRESH_TOKEN` Worker
  secret. The worker's self-deploy path exchanges it for a short-lived access
  token at the moment of use and persists any rotation in the deployment's own
  database (`self_update_oauth` — the secret is the chain's seed, the row its
  current state, with race-loss recovery and re-provisioning detection). An
  installer that finds nothing to provision from now fails loudly with a
  non-zero exit instead of completing a deploy that cannot self-update;
  `--disable-one-click` stays a sticky opt-out and now also withdraws (and
  best-effort revokes) a handed-over session; `--enable-one-click` runs the
  automatic provisioning first and only falls back to pasting a token with
  `--manual`.

  The portal's update card no longer presents the installer command as anyone's
  path: "Update now" is always the answer, the command is folded away as
  reference documentation, and a deployment with no self-deploy permission (one
  predating automatic setup, or an explicit opt-out) is reported as the fault
  state it is — with the repair (run a normal `--update`) — never as a routine
  platform difference.

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

### Patch Changes

- Updated dependencies [[`5db49fd`](https://github.com/StoryLark/storylark/commit/5db49fd67bfdbec51c22cfccf37827a7ed93971f), [`8f4a564`](https://github.com/StoryLark/storylark/commit/8f4a56463f850a9934e70a7907c643fe89250d54), [`972d37e`](https://github.com/StoryLark/storylark/commit/972d37e4b7b61860f4f76dfe0c61c05f41b10c4c)]:
  - storylark-contracts@0.5.0

## 0.17.1

### Patch Changes

- Sync the in-app roadmap (shown on the About screen) with the real
  shipped state — it had drifted badly behind storylark.org's own copy,
  still describing the removed GitHub-Actions self-update flow and
  missing everything shipped since roughly 0.9.0.

## 0.17.0

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

### Patch Changes

- [`c375711`](https://github.com/StoryLark/storylark/commit/c37571156dbe0179a9585952c533c09bab579b93) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Polish the admin portal's Narration card (AB#7412 follow-up).

  Two real gaps, not cosmetic ones: when every job was `pending`/`running` count
  was zero but one or more had actually `failed`, the card said "Nothing is
  waiting. Every chapter's audio matches its text." directly above a list of
  failed jobs waiting to be retried — true and false in the same breath. It now
  says a failed chapter is waiting on a retry instead. And each job's row showed
  only the finished audio's own duration; the time the synthesis actually took
  (`elapsedMs`, already returned by `GET /api/admin/narration` but never read by
  the card) was invisible, so there was no way to tell a normal narration from a
  slow one. Done jobs now show both — "took Xs to narrate · Ym of audio" — and a
  `running` job shows how long it has been running, computed from `startedAt`,
  so a job stuck near the 30-minute stale-claim window is visible before it gets
  reclaimed rather than after.

  Also brings this card in line with every other admin screen's pattern
  (`ContentSection.tsx`, `ThemeSection.tsx`): success and failure messages are
  now separate pieces of state, so a failed action (a queue request, a cancel)
  renders in the same `admin-error` red the rest of the portal uses instead of
  sharing a plain paragraph with ordinary status text.

- Updated dependencies [[`267dd3a`](https://github.com/StoryLark/storylark/commit/267dd3a8e07a4c42d81820bd6708ad07a76695c5)]:
  - storylark-contracts@0.4.0

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

- [`3744526`](https://github.com/StoryLark/storylark/commit/37445262f9a375611a9ccbf61032b790bf6d625a) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - The admin portal is a standalone page, not a screen in the reader app
  (AB#7404).

  `/admin` used to be one more client-side route inside the PWA bundle: every
  reader downloaded the operator UI, the service worker precached it, and the
  portal carried the reader's router, chrome, and state by construction. It is
  now a **second Vite entry** — its own document, its own bundle, and no share
  of the reader's runtime.

  - `packages/core/src/admin-entry.tsx` mounts the admin screen and nothing
    else. No router, no player, no library or manifest loading, no IndexedDB,
    no service worker registration. Stylesheets are shared (CSS is inert); code
    is not.
  - The HTML shell and the `/admin` dev route are generated by
    `adminPagePlugin()` in `storylark-core/vite`, so a site owns no admin file
    at all — nothing to scaffold, nothing to keep in sync, and `npm update
storylark-core` upgrades the portal's markup with everything else.
  - `admin.html` and `assets/admin-*` are excluded from the service worker
    precache and the page carries no web-app manifest link, so readers who
    install the PWA never carry admin code and an operator can never be looking
    at a cached admin UI while pushing a platform update.
  - The reader's router no longer has an `admin` route. Nothing in the reader
    links to the portal; reaching it is a full document load.

  Routing is unchanged on Cloudflare — Workers Assets already resolves `/admin`
  to the `/admin.html` asset before the SPA fallback runs. `platforms/azure/server.mjs`
  gains the three routes that reproduce that behaviour on Node
  (`/admin` serves `admin.html`; `/admin/` and `/admin.html` redirect to it),
  registered ahead of its SPA catch-all.

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

## 0.5.0

### Minor Changes

- [`8fed3b9`](https://github.com/StoryLark/storylark/commit/8fed3b9f86ad4dff03a9e7132ff11deab53c0a0d) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Read-along now holds a screen wake lock while narration is playing with the
  text on screen, controlled by a new "Keep screen awake" setting (on by
  default, shown only where the browser supports it, account-synced).
  Finishing a standalone story no longer auto-plays the next story by default:
  a new "Auto-play the next story" toggle in Settings → Playback (flat-library
  brands) makes continuing an explicit, account-synced choice. Chapters within
  a book always continue automatically.

## 0.4.0

### Minor Changes

- [`95e38e0`](https://github.com/StoryLark/storylark/commit/95e38e00711cb3ffb8f86dad44777c1426d34e16) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Traceable build identity. The app version shown in Settings/About is now storylark-core's real npm version (the hand-bumped APP_VERSION counter is gone), and About gains a "Version & build" section listing the version of every installed storylark-\* package plus the solution build's git commit, build time, and brand. The Vite preset injects this at build time via `virtual:storylark-build`. RELEASE-NOTES.md headings are now keyed to the same version number. worker/pipeline: expose `./package.json` in exports so build tooling can read their versions.

### Patch Changes

- [`60beb5f`](https://github.com/StoryLark/storylark/commit/60beb5fa54f86921ef6ac883aa8dad34d3b86fac) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Split the human-facing changelog from the Changesets-managed one: `CHANGELOG.md` is now
  Changesets' own file (auto-generated, don't hand-edit); curated release notes for the About
  screen and storylark.org now live in `RELEASE-NOTES.md`. App version bumped to 0.4.0 for the
  narrator voice picker; roadmap updated to reflect shipped npm packages and the voice picker,
  and to list the remaining M7 features and 1.0 hardening work.

<!-- Owned by Changesets — do not hand-edit. Human-facing release notes live in
     RELEASE-NOTES.md (imported by the About screen). -->

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
