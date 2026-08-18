# Upgrading — tracking StoryLark releases as a deployer

**Audience: whoever owns a StoryLark deployment's repository** — the person
who runs `npm install`, reviews a version bump, and decides when a site takes
a new release. If you're an operator who just wants to click a button in
`/admin`, see [`updating.md`](updating.md) instead — that page is the
in-portal story and assumes nothing about your repository. This page is what's
underneath it: how the packages version, what a "release" actually contains,
how your own clone or `npm create storylark` site takes one, and what a
breaking change looks like.

## The two docs, and why they're separate

| | [`updating.md`](updating.md) | This page |
|---|---|---|
| Audience | The operator, at `/admin` | The deployer, in a terminal |
| Assumes | A running site | A git clone (or an `npm create storylark` copy) of the repository |
| Answers | "How do I take the next release?" | "What is a release, and how does my copy of the repo move to it?" |

They describe the same underlying mechanism — [`design/update-flow.md`](design/update-flow.md)
is the third page, the implementation itself — from two different chairs.

## How versioning works

StoryLark ships as four independently-versioned npm packages, plus a scaffold
tool:

| Package | What it is | Versioned |
|---|---|---|
| `storylark-core` | The frontend engine — the app your readers load, `vite build --mode <brand>` | **Linked** with `storylark-worker` and `storylark-pipeline` (see below) |
| `storylark-worker` | The API server (Hono) — Cloudflare Worker or the Node/Azure entry | **Linked** |
| `storylark-pipeline` | The publish pipeline — parsing, neural TTS, forced alignment, storage upload | **Linked** |
| `storylark-contracts` | Shared, dependency-free code: the content validator, the zip reader, JSON schemas | **Independent** — currently a different number from the other three (0.5.x while they're at 0.18.x) |
| `create-storylark` | The `npm create storylark` scaffold tool | **Independent** |

Versioning is [Changesets](https://github.com/changesets/changesets)
(`.changeset/config.json`). `storylark-core`, `storylark-worker` and
`storylark-pipeline` are **linked** (`"linked": [["storylark-core",
"storylark-worker", "storylark-pipeline"]]`), meaning a changeset touching any
one of them bumps all three to the same new version number, even if the other
two have no code changes. That's deliberate: "StoryLark 0.18.0" is meant to
name one coherent release across the engine, the server and the pipeline,
not three numbers a deployer has to cross-reference. `storylark-contracts`
and `create-storylark` are not linked — they move on their own schedule.

### What each release-facing document covers

| Document | Owned by | Covers |
|---|---|---|
| `packages/*/CHANGELOG.md` | Changesets, auto-generated | Every version of that one package, one entry per changeset, machine-precise. The full record. |
| `packages/core/RELEASE-NOTES.md` | Hand-curated | Human-facing highlights, headed by `storylark-core`'s version number (the one the in-app About screen shows). Not every patch gets an entry — this is "what changed that a reader or an operator would notice," not a full log. |
| GitHub Releases | `release.yml`, automatic | One release per `storylark-core@<version>` tag, with the prebuilt engine artifact (`storylark-engine-<version>.zip` + its `.sha256`) attached. This is what `GET /api/admin/update-status`'s `releaseNotesUrl` and the in-portal "Update now" button both point at. |

If you're deciding whether a release affects you: check `CHANGELOG.md` for
the package you depend on directly (almost always `storylark-worker` and
`storylark-core` together, since they're linked). If you're deciding whether
to *tell your readers* something changed: `RELEASE-NOTES.md` is written for
that.

## How a clone or `npm create storylark` site upgrades

Every deployment is a git clone of this repository (or a copy `npm create
storylark` produced from it) with its `packages/core`, `packages/worker` and
`packages/pipeline` dependencies **pinned to an exact version** —
`--save-exact`, not a semver range — in the root `package.json`. That's the
same pin the installer writes on first deploy and the same one it moves on
`--update`:

```bash
npm install --save-exact storylark-core@latest storylark-worker@latest
```

(Azure's server also pins `storylark-worker` in `platforms/azure/`, its own,
deliberately non-workspace `package.json` — see
[`platforms/azure/README.md`](../platforms/azure/README.md).)

Exact pins mean nothing moves your deployment's version without you running
one of the two update paths:

- **The installer's `--update`** — the command layer documented in full in
  [`updating.md`](updating.md#the-command--the-floor-that-always-works):
  `node platforms/<cloudflare|azure>/install.mjs --update --yes`. In order:
  1. Bump the pin (`npm install --save-exact storylark-core@latest
     storylark-worker@latest`).
  2. `npm install`, then migrate — always in that order. The migration set
     ships *inside* the `storylark-worker` package (`packages/worker/migrations/`
     for D1, `packages/worker/migrations-postgres/` for Postgres), so
     migrating before installing would run the old migration set against a
     schema the new code expects to already be ahead of.
  3. Rebuild, with your brand untouched — `brands/<id>/`, `presentation/<id>/`
     and `deployment/<id>/` are never read or written by this path (see
     "What's brand-owned" below).
  4. Redeploy — `wrangler deploy --env <brand>` / Azure's zip deploy.

  This is the floor: it works from nothing but your own platform login, on
  every platform, every time, including as a repair for a deployment that has
  drifted.

- **The portal's "Update now" button** — `POST /api/admin/update-install`,
  the runtime-side half of the same mechanism, for a site that doesn't need a
  developer at a keyboard for routine releases. It downloads a **prebuilt
  engine artifact** (no `npm install`, no build step) rather than re-running
  the installer, and only falls back to a real platform deploy when a release
  changed the API server itself. Full mechanism:
  [`design/update-flow.md`](design/update-flow.md#the-prebuilt-engine-layer-3).

Both paths **migrate before they swap** — new schema under old code is a
state the old code tolerates; new code under old schema is not. Both are
idempotent: re-running either when there's nothing to do is a safe no-op.

### `storylark-contracts` and `create-storylark`

`storylark-contracts` is a dependency of `storylark-worker`,
`storylark-core` and `storylark-pipeline` (declared with an exact version in
each of their `package.json`s), so it moves when whichever of those three you
`npm install` pulls a new one — never separately. `create-storylark` only
matters at the moment you scaffold a new site; an existing deployment never
depends on it and updating it changes nothing about a site already running.

## What's brand-owned and never touched

Every update path — the installer's `--update`, the portal's "Update now",
and the underlying `readEnginePackage()`/`installEngineVersion()` machinery —
is built so that **there is no code path that can write your identity**:

- `brands/<id>/brand.json`, `brands/<id>/theme.css`,
  `brands/<id>/assets/icons/` — your name, colors, fonts, icons.
- `presentation/<id>/presentation.json` — your layout, nouns, defaults.
- `deployment/<id>/deployment.json` — your origins, TTS config, VAPID public
  key.
- Your content and your database rows.

Enforced structurally, not by convention: the prebuilt engine artifact format
itself **rejects** a package containing `brand.json`, `theme.css`,
`presentation.json`, `manifest.webmanifest` or any `icons/` file
(`readEnginePackage()`), and `installEngineVersion()` re-checks every path
against the same `isBrandOwned()` rule before writing anything — the same
fence, defined once in `storylark-contracts/engine-package`, checked twice.
`release.yml`'s own build step (`package-engine.mjs`) scans every byte of
every engine artifact for any string that appears in a brand file and fails
the release outright on a hit, so a regression that recompiled brand data
into the shared bundle would break CI rather than ship one customer's
identity to everyone else.

When a release adds a UI feature, it always ships with a sensible default
look, so an untouched theme keeps working exactly as it did before the
update.

## Breaking-change policy

**Package versions** follow ordinary semver, and because
`storylark-core`/`storylark-worker`/`storylark-pipeline` are linked, a major
bump in any one of them is a major bump in all three at once — there is no
such thing as "the worker went to 1.0 but the engine didn't." A major names a
breaking change somewhere in the linked set; check the three `CHANGELOG.md`s
for which package actually changed. `storylark-contracts` and
`create-storylark` follow semver independently and are not implicated by a
major on the linked set.

**The content API contract** — `/api/content/v1`, documented in
[`content-api.md`](content-api.md) — versions **separately from the
package number**, on its own integer `contractVersion`, carried both in the
URL path and in every request body. This is deliberate: `contractVersion` is
what a third-party publisher's release pipeline pins against for years, and
it must not move just because `storylark-worker` shipped a patch. The rules,
in full in [`content-api.md`](content-api.md#base-url-and-versioning):

- New optional fields never move `contractVersion`.
- Unknown fields in a request are ignored, not rejected — a client written
  against a newer minor contract keeps working against an older deployment.
- `contractVersion` moves only on a genuine breaking reshape of the request
  or response body.
- `GET /api/content/v1` reports the range (`supported.min`/`supported.max`)
  a given deployment accepts, so an integrator can check compatibility before
  sending anything.

So a package major (say, `storylark-worker` 1.0.0) can ship with
`contractVersion` unchanged, if nothing about the push contract's shape
actually broke — and the reverse: `contractVersion` bumping to 2 does not by
itself require a package major, though in practice a contract reshape of
that size is unlikely to arrive alone.

**Database migrations are additive, never destructive**, on both dialects
(`packages/worker/migrations/` for D1, `packages/worker/migrations-postgres/`
for Postgres) — see [`updating.md`'s rollback note](updating.md#rolling-back):
rolling an engine back does not undo a migration, because old code is
expected to tolerate new schema. A migration that needed to drop or rename a
column in a way old code couldn't tolerate would be the actual breaking
change, and is treated with the same weight as a linked-package major.

## How update PRs land for deployers

There is no per-deployment "update PR" StoryLark opens for you — that's a
distinction worth being explicit about, because the phrase suggests a bot
filing pull requests against *your* fork, which is not how this works.
Instead:

1. Every merge to `main` in the StoryLark repository runs
   [`release.yml`](../.github/workflows/release.yml)'s Changesets step, which
   maintains a single, continuously-refreshed **"Version Packages" PR** against
   `main` — accumulating whatever changesets have landed since the last
   release.
2. When a maintainer merges that PR, Changesets bumps the linked packages'
   `package.json` versions, regenerates each package's `CHANGELOG.md`,
   publishes all changed packages to npm, and cuts GitHub Releases (tagged
   `storylark-core@<version>` etc.).
3. `release.yml` then builds the brand-free prebuilt engine (`vite build
   --mode engine`), verifies it carries no brand data
   (`package-engine.mjs`), and attaches `storylark-engine-<version>.zip` +
   its `.sha256` to the `storylark-core@<version>` release.

That published release is the thing *your* deployment tracks — via
`GET /api/admin/update-status` reading the npm registry, or via `--update`
pulling the same registry. Your own repository never receives an automated
PR; you decide when to run `--update` (or click "Update now"), and that is
the entire deployer-side workflow. If you've forked or otherwise customized
beyond `brands/<id>/`, `presentation/<id>/` and `deployment/<id>/`, treat
merging upstream the same way you'd treat any other upstream merge — nothing
about the update mechanism assumes you haven't touched core code, only that
if you have, the exact-pin + migrate-then-swap discipline still applies to
whatever you build and deploy yourself.

## Related

- [`updating.md`](updating.md) — the operator's in-portal story: how you find
  out, "Update now", rollback, and what the button deliberately cannot do.
- [`design/update-flow.md`](design/update-flow.md) — the full mechanism: the
  three layers, the prebuilt engine artifact, the engine store, and the
  self-deploy permission, including what's been verified against real
  Cloudflare and Azure deployments.
- [`content-api.md`](content-api.md) — the content push contract's own
  versioning rules in full.
- [`deploy-worker.md`](deploy-worker.md) — every binding, environment
  variable and secret the worker needs per platform, including migrations.
