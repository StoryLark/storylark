# Design: Update Flow

How a deployed site takes a new engine release — the mechanism behind
[`updating.md`](../updating.md)'s operator-facing walkthrough.

**Diagram:** [`update-flow.drawio`](update-flow.drawio) — open in
[app.diagrams.net](https://app.diagrams.net) or the draw.io desktop app. *No
PNG export is committed yet* — open the file once and export a PNG
alongside it per the documentation standard.

## Why this shape

A Cloudflare Worker has no filesystem and no build tooling; it cannot run
`npm install` or `wrangler deploy` against itself. An Azure App Service
process technically *could* shell out to build tools, but doing that from
inside the process serving live traffic is fragile and hard to make safe.
So the deployment cannot update itself, full stop — something outside it
has to do the work.

The question is *whose* credential does that work, and where it lives. The
answer this design settles on: **the operator's own platform login, on the
operator's own machine.** The installer that created the deployment already
holds a `wrangler login` / `az login` session; there is no reason to
introduce a second credential, and every reason not to store one inside the
app. A deployment that can deploy itself is a deployment holding a standing
deploy permission — for a reading app, that's an unforced liability.

## The two layers

**Layer 1 — detect (in the deployment, zero credentials).** A scheduled
check (Cloudflare Cron Trigger / Azure `setInterval`,
`packages/worker/src/lib/update-check.ts`) compares the running
`storylark-worker` version against the public npm registry once a day, and
emails the operator if `ADMIN_EMAIL`/`RESEND_API_KEY` are configured.
`GET /api/admin/update-status` shows the same comparison in `/admin`, on
demand. Unauthenticated, read-only, works everywhere. This never triggers
anything — it only tells someone.

`/update-status` also returns `updateCommand`: the exact command for layer
2, chosen from the runtime it detects (`navigator.userAgent ===
'Cloudflare-Workers'` → the Cloudflare installer, otherwise the Node/Azure
one). Detected, not configured — an instruction that only works if someone
remembered to set an env var is worse than no instruction.

**Layer 2 — update (on the operator's machine, the only path that ships
anything).** `node platforms/<platform>/install.mjs --update --yes`:

1. Bumps the pinned engine version (`npm install --save-exact
   storylark-core@latest storylark-worker@latest`).
2. `npm install`, then migrate — in that order, always. `migrate-postgres.mjs`
   and the migration set both ship *inside* the `storylark-worker` package,
   so migrating before installing runs the old migration set and silently
   reports "up to date" against an incomplete schema.
3. Builds, with the brand untouched.
4. Deploys — `wrangler deploy --env <brand>` / `az webapp deploy`.

`--update` shares steps 2–4 verbatim with `--deploy` (one function,
`installMigrateBuildDeploy` / `migrateBuildDeploy`, called by both) so the
two paths cannot drift. What it does *not* share is provisioning: `--update`
never creates infrastructure, never edits `wrangler.jsonc`, never writes a
secret. That's what makes it safe to re-run at any time.

## What was removed, and why

Until AB#7403 landed this shape, `/admin` had an **Install update** button
that called `POST /api/admin/update-install`, which dispatched a
`self-update.yml` GitHub Actions workflow — and therefore required
`GITHUB_REPO` and `GITHUB_DEPLOY_TOKEN` to be stored on the deployment.
That is now removed outright: the route, the button, and the workflow
template.

Keeping it as a secondary "advanced" option was considered and rejected. It
would still require a GitHub account, a fork, and a standing
Actions:write credential inside the reading app — the exact thing it was
supposed to stop requiring — while adding a second code path to document,
test, and keep working. And it isn't a stepping stone to the eventual
one-click update either, which is designed around a *prebuilt release
artifact* and a platform-native deploy, not around triggering a rebuild in
CI. Running the update from a CI job is still perfectly possible for anyone
who wants it (the update command is just a Node script) — but with the
operator's CI holding the operator's credential, which is a different thing
from the app holding one.

A genuine one-click in-portal update remains a future phase, blocked on the
prebuilt-artifact work (brand/presentation as runtime data, so an update is
"download the bundle, keep your brand file, restart" rather than a rebuild).
Until that exists, the honest answer is a command.

## The hard rule, enforced by construction

Every step of `--update` only ever touches: the pinned version in
`package.json`, the database (via migrations), and the platform's own
build/deploy commands. There is no step that reads or writes `brands/<id>/`
— the function's body simply has no such step, so a bug can't accidentally
add one without someone deliberately writing it. Compare against
[`build-your-own-theme.md`](../build-your-own-theme.md): a brand's theme
and presentation live entirely outside anything an engine update can reach.
