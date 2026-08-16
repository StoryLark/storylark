# Changelog

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
