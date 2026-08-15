# Design: Update Flow

How a deployed site updates itself — the mechanism behind
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
The only architecture that's genuinely safe on both platforms is: **the
deployed app triggers its own CI**, and CI — which has a full filesystem,
build tools, and deploy credentials — does the actual work.

## The two halves

**Detect (proactive)** — a scheduled check (Cloudflare Cron Trigger /
Azure `setInterval`, `packages/worker/src/lib/update-check.ts`) compares
the running `storylark-worker` version against the npm registry once a
day, and emails the operator if `ADMIN_EMAIL`/`RESEND_API_KEY` are
configured. This never triggers an update by itself — it only tells someone.

**Approve + install (the only path that ships anything)** —
`GET /api/admin/update-status` shows the same comparison in `/admin`;
clicking **Install update** calls `POST /api/admin/update-install`, which
dispatches the site's own `self-update.yml` via `workflow_dispatch`. That
workflow bumps the pinned engine version, migrates (snapshotting the
database first on the Postgres/Azure path — D1's own time-travel recovery
covers the Cloudflare path), builds, and redeploys.

## The hard rule, enforced by construction

Every step in `self-update.yml` only ever touches: the pinned version in
`package.json`, the database (via migrations), and the build/deploy
commands. There is no step that reads or writes `brands/<id>/` — the
workflow's job list simply has no such step, so a bug can't accidentally
add one without someone deliberately writing it. Compare against
[`build-your-own-theme.md`](../build-your-own-theme.md): a brand's theme
and presentation live entirely outside anything an engine update can reach.
