# create-storylark

## 0.3.0

### Minor Changes

- [#12](https://github.com/StoryLark/storylark/pull/12) [`b8f2754`](https://github.com/StoryLark/storylark/commit/b8f27549307a784727349196c76e10e66d2f54b8) Thanks [@hcs-platform-app](https://github.com/apps/hcs-platform-app)! - Make npm-create the safe publisher default: install and lock all three
  StoryLark packages, record project provenance, verify before deployment, and
  ship read-only local/live diagnostics. Support existing Cloudflare resource
  names without changing brand identity.

  Treat repository validation as an atomic gate, report duplicate book
  declarations, and preserve narration/timing/voice metadata on no-op syncs.
  Add explicit matching-only adoption for existing live libraries: complete
  chapter, rendered-content, metadata, order, and cover parity is required before
  ownership can move to repo sync, while narration and content objects remain
  untouched. Read GitHub repositories path-first, batch authenticated Markdown
  reads to stay within the Workers Free subrequest budget, preserve legacy
  single-story chapter ids, and keep root-relative artwork hash-compatible with
  the publish pipeline.
  Update demo content and deployment documentation for both standalone stories
  and multi-chapter books, and move Sharp to its patched release.

## 0.2.0

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

## 0.1.2

### Patch Changes

- [`d234b67`](https://github.com/StoryLark/storylark/commit/d234b67bc585af610dff76c5ca4e128b5f466def) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Fix Azure's installer silently defaulting `APP_NAME` to the lowercase
  brand-folder id (e.g. `"storylark"`) instead of a real display name.
  `infra.bicep`'s `appName` parameter used to default to the `brand` folder
  parameter, while the Cloudflare installer already required `APP_NAME` as an
  explicit, human-entered value with no default. A fresh Azure deploy's
  `APP_NAME` — the WebAuthn passkey prompt name and the transactional/
  update-check email `From:` display name — ended up as a resource-naming
  slug, diverging from what a Cloudflare install of the same brand shows.

  `APP_NAME` is now a required field in `platforms/wizard.mjs`'s Azure prompt
  and `platforms/azure/install.mjs`'s `REQUIRED` list (matching Cloudflare's
  own installer exactly), always passed explicitly to `infra.bicep`, which no
  longer has a default for `appName` at all. Does not touch the admin
  portal's own title, which already reads `brand.json`'s `appName` at runtime
  via `BRAND.appName` (fixed earlier this session) rather than echoing
  `APP_NAME`.
