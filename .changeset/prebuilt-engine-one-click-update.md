---
'storylark-contracts': minor
'storylark-core': minor
'storylark-worker': minor
---

A prebuilt engine, and a button that installs it (AB#7418 — plan §4 layer 3, §0d Phase 5)

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
--yes`: on Cloudflare that stores a Workers-Scripts-scoped API token *you* issued as
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
