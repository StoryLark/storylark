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
answer this design settles on by default: **the operator's own platform
login, on the operator's own machine.** The installer that created the
deployment already holds a `wrangler login` / `az login` session; there is
no reason to introduce a second credential, and every reason not to store
one inside the app. A deployment that can deploy itself is a deployment
holding a standing deploy permission — for a reading app, that's an
unforced liability unless the owner decides otherwise, deliberately, for
their own deployment. Layer 3 below is that decision, and nothing else.

## The layers

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

**Layer 3 — one-click, in the portal (opt-in, off by default).** See
[The prebuilt engine](#the-prebuilt-engine-layer-3) below. It does not
replace layer 2 and does not change anything above: a deployment that has
not opted in behaves exactly as this section describes.

## The prebuilt engine (layer 3)

### What changed to make it honest

The constraint at the top of this document has not moved: a deployment
still cannot *build* itself. What changed is that it no longer has to.

Until Phases 1–3 of the layer plan, the brand, the presentation and the
deployment config were compiled into the JS bundle. There was therefore no
such thing as "the engine build" — only *a customer's* build. Now all three
are runtime data injected into every document, and a fourth mode,
`vite build --mode engine`, resolves them to **empty**. What comes out is
the same bytes for every deployment on a given version.

Measured, not assumed. Two brand builds of 0.14.0 (`storylark` and
`nebula`) agree on 212 of 232 output files and differ on exactly the six
that carry brand — `index.html`, `admin.html`, `sw.js` and the three entry
chunks — plus the brand-owned files themselves. An `--mode engine` build is
219 files, byte-identical across runs (with `STORYLARK_BUILD_TIME` set), and
contains **zero** occurrences of any string that appears in a brand file but
not in core's own source. `package-engine.mjs` re-runs that scan on every
release and fails the build on a hit, so it is a gate rather than a claim.

### The artifact

`storylark-engine-<version>.zip`, attached by `release.yml` to the GitHub
Release changesets already cuts for `storylark-core@<version>`, alongside a
`.sha256`:

```
engine.json                  versions, and a sha256 per file
dist/**                      the brand-free site build
worker/index.js              the bundled Cloudflare Worker
migrations/*.sql             the D1 set, for this version
migrations-postgres/*.sql    the Postgres set, likewise
```

The migrations travel *with the code they belong to* because the order that
matters is migrate-then-swap and the set that has to run is the new one —
the failure `install.mjs` documents at length is a bumped version whose
migrations were still the old ones.

What is **not** in it: `brand.json`, `presentation.json`, `theme.css`,
`manifest.webmanifest`, `icons/`. `readEnginePackage()` rejects a package
containing any of them. Shipping one customer's identity to every other
customer is the worst thing this feature could do, so it is made
structurally impossible rather than merely avoided.

### The flow

1. **Is there a target?** No credential, no button, `501` from the route.
2. **Which version?** The npm registry — the same source the portal showed,
   so the number clicked is the number installed.
3. **Download and verify.** Checksum first, then the package's own per-file
   digests. Nothing has touched the deployment yet, by construction: the
   first call that can is inside `install()`.
4. **Migrate, then swap**, inside the platform target.

### Per platform

**Cloudflare** — an API token the operator issued, scoped to
`Workers Scripts | Edit`, stored as a Worker secret. The update follows
Cloudflare's documented direct-upload flow: register an asset manifest, get
back only the hashes Cloudflare does not already hold (which on a normal
release excludes the six font families), upload those, then
`PUT /accounts/:id/workers/scripts/:name/content` — *"put script content
without touching config or metadata"*. That endpoint is chosen precisely
because the full script-upload endpoint would require rebuilding every
binding, var, secret, route and cron trigger from the outside and would
silently drop anything it failed to reconstruct.

The manifest is authoritative — Cloudflare deletes anything left out of it —
so the deployment's own brand files are read back through `env.ASSETS` and
re-uploaded. Knowing *which* files those are needed a new build output,
`dist/outputs.json`, because `env.ASSETS` can fetch a known path but cannot
list, and icon names come from `brands/<id>/assets/icons/` and are a brand's
business. A site built before that file existed falls back to the standard
icon names.

**Azure App Service** — no stored credential. `IDENTITY_ENDPOINT` /
`IDENTITY_HEADER` yield a short-lived Microsoft Entra token, and Kudu's
`POST /api/publish?type=zip` accepts one. The process stages its own
`wwwroot` with the engine replaced and the brand files kept, rewrites
`package.json` to pin the artifact's `storylark-worker`, and posts the zip;
`SCM_DO_BUILD_DURING_DEPLOYMENT` (already `true` in `infra.bicep`) makes App
Service install the new engine and restart. §4 assumed a stored credential
here; the platform makes one unnecessary, and this is the better design.

### What is verified, and what is not

Verified for real: the artifact build and its brand-free gate; the package
format and every way it can be refused; the download and checksum over real
HTTP; D1 migrations against a real SQL engine, writing wrangler's own
`d1_migrations` table; the Azure stager against a real filesystem; and the
whole route end to end inside a live `wrangler dev` with real D1 and real
assets, which downloaded a real 3.4MB artifact, verified its real checksum,
and produced a 230-file manifest carrying all 11 of that deployment's own
brand files.

**Not verified: Cloudflare's and Azure's own servers accepting the calls.**
Both are exercised against local servers implementing the published
contracts, and the tests assert the exact requests. What no test here can
prove is that the vendors agree with their own documentation — proving that
needs a credential capable of redeploying a live site, which is the risk
this design exists to bound rather than to take casually. The specific open
question on Cloudflare is whether `/content` honours `assets.jwt`: the
documented metadata shape lists `assets` for the script, version and
Workers-for-Platforms upload endpoints, and `/content` is a fourth. If it
does not, the first real run fails with the API's own 4xx, the portal shows
it, and nothing is deployed — the failure mode is a red message, not a
broken site.

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

That prebuilt-artifact design is now built — see
[The prebuilt engine](#the-prebuilt-engine-layer-3) above — and it is a
different shape from what was removed in every way that mattered: no
GitHub credential, no rebuild, no third party, opt-in, and off by default.
The command remains the answer for anyone who does not opt in, which is
everyone until they say otherwise.

## The hard rule, enforced by construction

Every step of `--update` only ever touches: the pinned version in
`package.json`, the database (via migrations), and the platform's own
build/deploy commands. There is no step that reads or writes `brands/<id>/`
— the function's body simply has no such step, so a bug can't accidentally
add one without someone deliberately writing it. Compare against
[`build-your-own-theme.md`](../build-your-own-theme.md): a brand's theme
and presentation live entirely outside anything an engine update can reach.
