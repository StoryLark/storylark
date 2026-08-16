# storylark-worker

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
