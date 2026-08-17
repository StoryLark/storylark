# storylark-contracts

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
