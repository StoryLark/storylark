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

**Layer 3 — "Update now", in the portal.** One button, identical on every
platform, and since the engine store landed it is no longer opt-in for the
common case: a release that only changes the engine installs through the
deployment's own storage with zero credentials (see
[The engine store](#the-engine-store-how-update-now-needs-no-platform)
below), and a release that changes the worker rides a self-deploy
permission the installer provisions as part of a normal install. Layer 2
remains the floor: always shown, always working, and the only path in the
one degraded state left (worker changed + self-deploy disabled or
never provisioned).

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

1. **Which version?** The npm registry — the same source the portal showed,
   so the number clicked is the number installed. (`storylark-core`'s
   version names the release; see the note in routes/admin.ts.)
2. **Download and verify.** Checksum first, then the package's own per-file
   digests. Nothing has touched the deployment yet, by construction.
3. **Which mechanism?** Decided from the downloaded package's own
   `workerVersion` against the running worker's — not from a registry
   guess. Worker unchanged → the engine store (below): migrate in-process,
   write the files, flip the pointer. Worker changed → the platform target;
   and only when THAT is absent does the route answer `501` with the
   command. Never surfaced as a user-facing tier: one button, one result.
4. **Migrate, then swap** — always in that order, whichever mechanism.

### The engine store — how "Update now" needs no platform

The deploy-API path above was only ever needed because the engine's files
lived in the immutable build. The theme store (AB#7417) had already proven
the alternative: write files into the deployment's own `ContentStore` — R2
on Cloudflare, Azure Blob or a local directory on Node, the same seam
content editing and themes already bind — and have the serving path prefer
them over the build. `packages/worker/src/lib/engine-store.ts` applies
exactly that to the engine itself:

```
engine/active.json                 the version being served (+ its file list)
engine/index.json                  the version history (five kept, live pinned)
engine/versions/<vid>/dist/<path>  each installed engine, immutable, prefixed
```

Properties that matter, and how they are held:

- **Atomic flip.** The HTML references hashed asset names, so documents and
  bundle must move together. `active.json` is written LAST, names one
  version, and carries that version's complete file list — a request
  resolves it once and serves every byte from that one version's prefix.
  There is no "newest file wins" anywhere.
- **Stragglers survive.** A client that loaded version N-1's HTML just
  before the flip still requests N-1's hashed assets; they live under their
  own prefix until history evicts them (which is why the history floor is
  2), and the serving path falls back to the history on an active-version
  miss.
- **Identity is unwritable, twice.** `readEnginePackage` rejects a package
  carrying `brand.json`, `theme.css`, `presentation.json`,
  `manifest.webmanifest` or `icons/`; `installEngineVersion` re-checks
  `isBrandOwned` on every path before writing. Both fences are the same
  rule from `storylark-contracts/engine-package` — defined once.
- **Rollback is a pointer move.** `activateEngineVersion` re-points at an
  archived version after verifying its files still exist; "serve the
  built-in engine" deletes only the pointer. Both leave the history intact.

**The cost, stated:** `run_worker_first` in wrangler.jsonc is now `/*` with
no `/assets/*` exclusion — every asset request costs a Worker invocation,
because an installed engine's bundle lives in storage the asset router
cannot see. Mitigated where it matters: the store check is a negative-result
cache (~10s TTL, module-level in engine-store.ts so an install resets it in
the same isolate), so a deployment with nothing installed — the default —
pays one in-memory check per asset request, not a storage read. The TTL is
made invisible to clients holding a just-installed engine's HTML by a
fresh, cache-bypassing re-check whenever a hashed-asset request would
otherwise fall through to the SPA shell.

The Node/Azure entry (`platforms/azure/server.mjs`) serves the same store
through the same `readActiveEngineCached`, so the mechanism — and the code
that implements it — is one thing, not a per-platform pair.

### The remaining boundary, honestly

A running Cloudflare Worker cannot replace its own script: no eval, no
remote dynamic import — a platform restriction, not a design choice. So a
release that changes `storylark-worker` still needs a platform deploy, and
that needs a permission. The requirement's answer is to absorb it at
INSTALL time rather than surface it to the operator: Azure's installer
provisions a managed identity + Website Contributor automatically during
`--deploy`/`--update`; Cloudflare's tries to mint a `Workers Scripts |
Edit`-scoped token with the credential the install already used (falling
back to storing that credential, disclosed), and says plainly when an
OAuth-only login makes neither possible. `--disable-one-click` turns it
off and records `SELF_UPDATE=off` in install.env so a routine update does
not undo the choice. The one state where the portal shows a command
instead of completing the update itself is: worker changed AND no
self-deploy permission exists.

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

**Cloudflare's own API: now verified for real, against `app.storylark.dev`
(the project's own demo deployment, 2026-08-16) — not a customer's site.**
The first two real attempts failed, and both failures were real, useful
findings rather than reasons to stop:

1. `PUT .../scripts/:name/content` does not exist for an asset-backed
   Worker at all — exactly the open question this section used to flag as
   unverified, now answered "no." The correct endpoint is the plain script
   upload (`PUT .../scripts/:name`, no `/content`), which does accept
   `assets.jwt` but replaces the Worker's *whole* configuration, so
   bindings have to be resupplied rather than avoided. Fixed by reading
   them back via `GET .../settings` first and resending them unchanged —
   the same "read back what's really there" principle already used for
   brand assets.
2. Re-sending a `secret_text` binding by name with no value is **rejected**
   by Cloudflare's API ("invalid or missing text property"), not treated
   as "keep the stored value" as first assumed. The real rule: secrets are
   independent of the bindings list, and any secret simply left out of an
   upload is preserved automatically from the previous version. Fixed by
   omitting `secret_text` bindings entirely rather than referencing them.

The third real attempt succeeded completely: real download, real checksum,
real migration check, real asset diff-and-upload (230 assets, mostly
already present and skipped), real binding read-back (secrets correctly
omitted), real script swap, and the site immediately serving the new
version with D1, R2, admin auth and every secret intact — confirmed by
re-checking that `oneClick` stayed available afterward, i.e. the
mechanism survived redeploying itself and can be clicked again.

**Azure's managed-identity path: now also verified for real, against
`storylark-dev-app` (2026-08-16) — three real bugs found and fixed along
the way, each only reachable once the previous one was out of the way:**

1. `POST /api/admin/update-install`'s default version resolution asked
   the npm registry for `storylark-worker`'s latest version and used it
   to build the GitHub release tag, which is keyed by `storylark-core`'s
   version instead. The two packages can now version independently under
   changesets — a worker-only patch (this deployment's own earlier
   self-deploy fixes) left them different for the first time, and the
   admin portal's button (which always POSTs an empty body) 404'd
   looking for a release that was never going to exist. Fixed by
   resolving the default from `storylark-core`'s own registry entry.
2. Azure's `server.mjs` sets `ENGINE_RELEASE_REPO` to `process.env.
   ENGINE_RELEASE_REPO ?? ''` — an empty string when unset, not
   `undefined` (Node env vars don't distinguish "absent" the way a
   Cloudflare Workers binding does). `findEngineRelease()`'s default
   resolved with `??`, which only falls back on `null`/`undefined`, so
   the empty string produced a real `https://github.com//releases/...`
   404. Fixed with a truthy check, matching how `ENGINE_RELEASE_BASE` was
   already handled.
3. `migrate-postgres.mjs` shipped in the published npm tarball (it was
   listed in `package.json`'s `files`) but was missing from `exports` —
   Node's strict exports-map resolution rejects any subpath not listed
   there regardless of `files`. `self-deploy.mjs`'s
   `createRequire(...).resolve()` threw, and the surrounding catch turned
   that into a false "file is missing." This bug had been live since
   Postgres migrations were added — `install.mjs`'s layer-2 `--update`
   path never hit it, since it joins the path directly instead of asking
   Node's module resolver, so only the one-click path was ever exposed to
   it. Fixed by adding the missing `exports` entry.

The fourth real attempt succeeded completely: real download, real
checksum, real Postgres migrations (7 files applied), real staging (219
engine files, 11 of the deployment's own brand files kept), a real 13.4MB
zip accepted by Kudu, and the site immediately serving the new version
with its content and admin session intact — confirmed by re-checking that
`oneClick` stayed available afterward, same as the Cloudflare check.

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
