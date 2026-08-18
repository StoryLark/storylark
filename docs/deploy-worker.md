# Deploy Worker — the complete reference

**Every binding, environment variable and secret `storylark-worker` reads,**
on both platforms, plus migrations, cron triggers, the assets binding and
custom domains. This is the exhaustive technical reference; for the
step-by-step walkthrough of standing up a new branded site, see
[`deploy-your-own.md`](deploy-your-own.md) (Cloudflare) or
[`deploy-azure.md`](deploy-azure.md) (Azure). Everything here is read straight
out of the source that defines it — chiefly
[`packages/worker/src/types.ts`](../packages/worker/src/types.ts)'s `Env`
interface, `wrangler.jsonc`, `platforms/azure/server.mjs` and
`platforms/azure/content-store.mjs` — so if a field here and a running
deployment disagree, the source is the tie-breaker.

## One worker, two runtimes

`storylark-worker` is a single Hono app (`packages/worker/src/index.ts`,
exported as `app`) that runs unmodified on either platform. What differs is
only how each platform's **entry point** constructs the `Env` object the app
expects:

- **Cloudflare** (`packages/worker/src/index.ts`'s default export) — Cloudflare
  hands the Worker its bindings directly (`wrangler.jsonc`'s `d1_databases`,
  `r2_buckets`, `vars`, secrets set with `wrangler secret put`). The default
  export wraps the raw D1 binding in the platform-agnostic `Database` seam and
  in-place-binds `CONTENT_STORE` from the `CONTENT` R2 bucket before calling
  `app.fetch()`.
- **Azure / any Node host** (`platforms/azure/server.mjs`) — reads
  `process.env`, builds a Postgres `Database` from `DATABASE_URL`, builds
  `CONTENT_STORE` from either an Azure Blob connection string or a local
  directory (`content-store.mjs`), and calls the same `app.fetch()`.

Route code in `packages/worker/src/routes/*.ts` never branches on platform —
it only ever sees the `Env` interface below.

## Bindings & storage — the platform-specific seam

| Interface field | Cloudflare | Azure / Node |
|---|---|---|
| `DB` (`Database & ConflictInsert`) | D1 binding (`d1_databases[].binding: "DB"` in `wrangler.jsonc`), wrapped by `d1Database()` | `postgresDatabase(DATABASE_URL)` — `packages/worker/src/db/postgres.ts` |
| `CONTENT` (`R2Bucket`, Cloudflare-only field) | R2 binding (`r2_buckets[].binding: "CONTENT"`) — also used directly for same-origin content serving (`GET /manifest.json`, `GET /books/*`) | not used; Azure has no equivalent binding-typed field |
| `CONTENT_STORE` (`ContentStore`, platform-agnostic) | Derived **in-place** from `CONTENT` at request time if a bucket is bound and `CONTENT_STORE` isn't already set | `azureBlobContentStore(AZURE_STORAGE_CONNECTION_STRING, container)` **or** `localContentStore(STORYLARK_LOCAL_CONTENT)` — see `content-store.mjs`. Optional: with neither set, the portal's content-editing, theme and engine-install routes answer `501 no_content_store` |
| `ASSETS` (`Fetcher`) | The `assets` binding (`wrangler.jsonc`'s top-level `assets.directory: "app/dist"`) | Not a typed field on Azure — `server.mjs` serves `app/dist` itself via `@hono/node-server/serve-static`, and re-implements the same routing rules (SPA fallback, `/admin` → `admin.html`, hashed `/assets/*`, `/icons/*`, `/theme.css`, `/manifest.webmanifest`) by hand, since Hono has no Azure Functions adapter to hang a native assets binding off of |
| `SELF_DEPLOY` (`SelfDeployTarget`, optional) | Built in-place from `CF_API_TOKEN`/`CF_OAUTH_REFRESH_TOKEN` + `CF_ACCOUNT_ID` when present | Built from the App Service **managed identity** (`IDENTITY_ENDPOINT`/`IDENTITY_HEADER`, injected automatically by Azure — no stored credential) via `platforms/azure/self-deploy.mjs`'s `azureSelfDeploy()` |

## Environment variables & secrets — the full list

Every field below is on `Env` in `packages/worker/src/types.ts` unless noted
as Azure-process-only (read directly from `process.env` by `server.mjs` /
`content-store.mjs` rather than passed through the typed `Env`).

Cloudflare distinguishes **vars** (`wrangler.jsonc`'s `vars` block, plaintext,
visible in the dashboard and in `wrangler.jsonc` if committed) from
**secrets** (`wrangler secret put <NAME> --env <brand>`, encrypted, never in
the repo). Azure has one flat namespace — App Service **Application
Settings** — so the required/secret distinction is only "does this need to
stay out of the repo," not a platform mechanism.

### Required — the site will not boot correctly without these

| Field | Cloudflare | Azure | What it is |
|---|---|---|---|
| `DB` | D1 binding | `DATABASE_URL` (App Setting) → `postgresDatabase()` | Accounts, sessions, progress, bookmarks, preferences, the narration queue, admin setup/recovery, content-API tokens. |
| `BRAND` | var | App Setting | The brand id — selects `brands/<id>/`, matches the build's `--mode`, and is the fallback content-container name (`<BRAND>-content`) on Azure. |
| `APP_ORIGIN` | var | App Setting | Where the app is served, e.g. `https://app.example.com`. Used for session cookies, OAuth redirect URIs, magic-link/password-reset links, the webhook URL reported by `GET /api/admin/content-source`, and injected into every document/service-worker at request time (`lib/deployment.ts`) so changing it needs no rebuild. |
| `MAIL_FROM` | var | App Setting | The `From:` header for transactional email (password reset, magic link). |
| `APP_NAME` | var | App Setting | Human-readable display name — the WebAuthn passkey prompt, transactional email subject lines. |
| `ASSETS` | `assets` binding (`wrangler.jsonc`) | N/A — `server.mjs` serves `app/dist` itself | The built PWA. |

Azure additionally hard-requires `CONTENT_ORIGIN` in its own startup check
(`server.mjs`'s `required` array) even though the `Env` interface marks it
optional — Azure has no same-origin content-serving fallback the way the
Cloudflare Worker does (see below), so an Azure deployment must set it (to a
real content domain, or explicitly to `""`).

### Content origin & storage

| Field | Type | Default | What it is |
|---|---|---|---|
| `CONTENT_ORIGIN` | var (both platforms) | `""` (same-origin) | Where published content is served from. **Empty is a real, supported value on Cloudflare**: `GET /manifest.json` and `GET /books/*` answer straight out of the `CONTENT` R2 bucket, so a fresh Cloudflare deployment needs no content DNS at all. Set it to a real domain (e.g. `https://content.example.com`) only to move content onto its own domain with an R2 custom domain attached (see "Custom domains" below). |
| `CONTENT_STORE` | bound, not set directly | — | See "Bindings & storage" above. Optional everywhere: a deployment without one serves content fine and simply can't be edited from the portal (every content/theme/engine-install route answers `501 no_content_store` with an explanation instead of a confusing failure). |
| `AZURE_STORAGE_CONNECTION_STRING` | Azure-process-only (`content-store.mjs`) | unset | Selects the Azure Blob content driver. Container defaults to `<BRAND>-content`; override with `CONTENT_CONTAINER`. |
| `CONTENT_CONTAINER` | Azure-process-only | `<BRAND>-content` | Blob container name override. |
| `STORYLARK_LOCAL_CONTENT` | Azure-process-only | unset | Selects a local-directory content driver instead of Blob — takes precedence if both are set. Same object layout `publish.mjs --local <dir>` writes; how the Azure path is developed and tested with no cloud account. |
| `CONTENT_REVISIONS` | var/secret | `5` | Text revisions kept per chapter (the editor's undo history). |
| `CONTENT_MAX_UPLOAD_BYTES` | var/secret | 8 MB | Ceiling for a portal image upload (`POST /api/admin/upload`). |

### Content sync (pulling from a repo — wave 2 / Connections)

| Field | Type | Default | What it is |
|---|---|---|---|
| `CONTENT_SYNC_TOKEN` | **secret**, never a var | unset | Read-only credential for the repo content sync (`content-sync.md`). Set as a platform secret (`wrangler secret put CONTENT_SYNC_TOKEN`) when the connected repo is private and you'd rather not store the token in the database via the portal's form. When absent, a token entered in **Connections** (stored in the database) is the fallback; the secret wins when both exist. A public repo needs neither. |
| `CONTENT_SYNC_ARCHIVE_BASE` | test seam only | unset | Points the provider archive fetch at a local server. **Never set in production.** |

### Theme & engine version history

| Field | Type | Default | What it is |
|---|---|---|---|
| `THEME_VERSIONS` | var/secret | `5` | Installed theme packages kept for rollback (`design/theme-packages.md`). The live one is never aged out regardless of this number. |
| `ENGINE_VERSIONS` | var/secret | `5`, floor `2` | Installed engine versions kept for rollback (one-click updates, `design/update-flow.md`). |
| `ENGINE_RELEASE_REPO` | var/secret | `StoryLark/storylark` | Where prebuilt engine artifacts are published — a GitHub repo, for `POST /api/admin/update-install`'s release lookup. |
| `ENGINE_RELEASE_BASE` | var/secret | unset | A plain static host for artifacts, used instead of the GitHub Releases API. |

### Auth, push & admin secrets

| Field | Type | Required for | Notes |
|---|---|---|---|
| `VAPID_PUBLIC_KEY` | var (also baked into `deployment/<id>/deployment.json`'s `vapidPublicKey`) | Web push | Generate with `node packages/pipeline/gen-vapid.mjs`. See [`push.md`](push.md). |
| `VAPID_PRIVATE_KEY` | **secret** | Web push | Worker-only; never in `deployment.json`. |
| `ADMIN_KEY` | **secret** | `POST /api/admin/publish`, `POST /api/admin/setup`, `POST /api/admin/setup/reset`, the content API's key door, the theme/narration import doors | **Not** the admin login — `/admin` is gated by a normal email+password/passkey account (`admin-guide.md`). This secret mints the first admin setup link and printed recovery codes, and authenticates every headless caller (`packages/pipeline/publish.mjs`, the narration worker, a third-party CMS calling the content API directly). Without it, publishing still works but there's no way to create the first operator account. Hand a **scoped content-API token** (`POST /api/admin/content-tokens`) to any third-party system instead of this — it authenticates the content API only and nothing else. |
| `RESEND_API_KEY` | **secret** | Magic-link email, password reset email, update-check email | Only strictly required for password reset (always reachable, even though magic-link itself is dormant with no UI entry point). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | var / **secret** | Google sign-in | Only if you enable the (currently dormant, no UI entry point) Google OAuth path. |

Password + passkey sign-in need none of the above.

### Admin-portal story upload (optional feature)

| Field | Type | What it is |
|---|---|---|
| `GITHUB_REPO` | var/secret | `owner/repo` for your site's own repository. |
| `GITHUB_DEPLOY_TOKEN` | **secret** | A fine-grained PAT with `Contents:write` + `Actions:write` on just that repo. `POST /api/admin/publish-story` commits markdown via the GitHub Contents API and dispatches `publish.yml`. |

Without both, story upload from `/admin` answers `501 not_configured` and
everything else is unaffected. **Engine updates never use these** — see
[`upgrading.md`](upgrading.md) and [`updating.md`](updating.md).

### Operator notifications

| Field | Type | What it is |
|---|---|---|
| `ADMIN_EMAIL` | var/secret | With `RESEND_API_KEY` also set, the scheduled check (Cloudflare Cron Trigger / Azure `setInterval`) emails this address when a new release exists. Without it, the check still runs but stays silent; `GET /api/admin/update-status` always works regardless. |

### One-click updates (self-deploy permission)

Every field in this group is **optional**, and a deployment with none of them
set behaves exactly as it did before the feature existed: `update-status`
reports `oneClick.available: false` with a reason, and `POST
/api/admin/update-install` falls back to the installer command whenever a
release changes the API server itself (an **engine-only** release still
installs with zero credentials on every platform — see
[`upgrading.md`](upgrading.md)). This is the default and recommended posture.

| Field | Cloudflare | Azure | What it is |
|---|---|---|---|
| `CF_API_TOKEN` | **secret** | N/A | A Cloudflare API token the operator issued (or the installer minted), scoped to `Workers Scripts \| Edit`, stored as a Worker secret. Deliberately never in `deployment/<id>/deployment.json`. |
| `CF_ACCOUNT_ID` | var | N/A | Needed alongside `CF_API_TOKEN`/`CF_OAUTH_REFRESH_TOKEN`. |
| `CF_OAUTH_REFRESH_TOKEN` | **secret** | N/A | The alternative to `CF_API_TOKEN` when the operator authenticated with `wrangler login` (OAuth) rather than an API token — Cloudflare gives no way for a wrangler OAuth session to mint API tokens, so the installer hands the session itself to the deployment. Either credential enables the same `SelfDeployTarget`; `CF_API_TOKEN` wins when both exist. |
| `CF_SCRIPT_NAME` | var | N/A | Defaults to `BRAND`, which is what the installer names the Worker. |
| `CF_API_BASE`, `CF_OAUTH_TOKEN_URL`, `CF_OAUTH_CLIENT_ID` | test seams only | N/A | **Never set in production.** |
| — | N/A | **No credential at all.** `IDENTITY_ENDPOINT`/`IDENTITY_HEADER` (Azure-injected automatically when a system-assigned managed identity is enabled) yield a short-lived Entra token; Kudu's zip-deploy endpoint accepts it directly. Turn off with `az webapp identity remove` or by deleting the role assignment. | Azure's equivalent permission is a **Website Contributor** role assignment on the one Web App, provisioned by the installer — never a stored secret. |

### TTS / narration config (not read by the worker; carried for the frontend)

| Field | Type | What it is |
|---|---|---|
| `TTS_VOICE`, `TTS_RATE`, `TTS_OUTPUT_FORMAT`, `TTS_VOICES` | var/secret, all optional | Read by nothing in the worker itself — they exist only so the deployment-config contract injected into documents (`lib/deployment.ts`) is complete. The **publish pipeline** (`packages/pipeline/`) is what actually consumes narration config, from `deployment/<id>/deployment.json`. |

### Runtime-only (Azure `server.mjs`, not part of `Env`)

| Field | What it is |
|---|---|
| `PORT` | The port `server.mjs` listens on. Default `8787`. |
| `STATIC_ROOT` | Where `app/dist` lives on disk. Default `./app/dist`. |

## Migrations — both dialects

Migrations live inside the `storylark-worker` package and travel with the
code they belong to (both for a normal deploy and for the prebuilt engine
artifact — see [`upgrading.md`](upgrading.md#how-a-clone-or-npm-create-storylark-site-upgrades)):

| Dialect | Location | Applied by |
|---|---|---|
| SQLite (D1) | `packages/worker/migrations/*.sql` | `npx wrangler d1 migrations apply <brand> --env <brand> --remote` (first deploy); the installer's `--update`/`--deploy` path and the engine store's in-process migrator (`applyD1Migrations`) thereafter. |
| Postgres | `packages/worker/migrations-postgres/*.sql` | `packages/worker/migrate-postgres.mjs` (`npm run migrate` in `platforms/azure/`), pointed at `DATABASE_URL`; the same script, called with a `--dir` flag pointed at the artifact's own migration set, on the self-deploy path (`applyPostgresMigrations` / `platforms/azure/self-deploy.mjs`). |

Both sets are numbered identically (`0001_init.sql` through
`0009_content_connections.sql` as of this writing) and applied in order,
**always before the code that needs them starts serving** — migrate-then-swap
is the one hard rule every update path (installer, engine store, platform
self-deploy) shares. Cloudflare D1 has time-travel recovery built in, so a bad
migration is recoverable without preparation; Azure Postgres does not, so
`updating.md` recommends a `pg_dump` snapshot before an update that touches
schema.

What each numbered migration added, briefly, for orientation:

| # | Adds |
|---|---|
| 0001 | Core schema — users, sessions, progress, bookmarks, push subscriptions, magic links, `library_state`. |
| 0002 | `passkey_credentials`. |
| 0003 | Password auth columns on `users`, `oauth_identities`. |
| 0004 | `password_resets`. |
| 0005 | `rate_limits`. |
| 0006 | `user_preferences`. |
| 0007 | Admin accounts — `is_admin` on `users`, `admin_setup_tokens`, `admin_recovery_codes`. |
| 0008 | The narration queue and its job table. |
| 0009 | Content connections — the sync-state row, `content_api_tokens` (scoped content-API tokens). |

A database that predates a given migration degrades gracefully rather than
500ing: routes that depend on it (e.g. narration, `content-source`,
`content-tokens`) answer `available: false` or `501` with an explanation
telling you which migration to apply — see the relevant tables in
[`api.md`](api.md).

## Cron triggers

One scheduled job, two jobs riding it:

- **Cloudflare**: `wrangler.jsonc`'s `env.<brand>.triggers.crons`, e.g.
  `["0 13 * * *"]` (daily). Invokes the Worker's `scheduled()` export.
- **Azure**: `setInterval(..., 24 * 60 * 60 * 1000)` in `server.mjs` — the
  process stays warm (App Service **Always On**), so an interval does the
  same job a Cron Trigger does.

Both call, in parallel:

1. `checkForUpdateAndNotify(env)` — the update-check email (`ADMIN_EMAIL` +
   `RESEND_API_KEY`; no-ops silently without both).
2. `scheduledContentSync(env)` — the repo content sync (design §10.3), riding
   the same schedule deliberately rather than adding new infrastructure. Self-gates
   on the connection's configured `intervalHours` and no-ops (one cheap
   database read) on a deployment with no repo connected.

## The assets binding & routing

Cloudflare's `wrangler.jsonc`:

```jsonc
"assets": {
  "directory": "app/dist",
  "binding": "ASSETS",
  "run_worker_first": ["/*"],
  "not_found_handling": "single-page-application"
}
```

`run_worker_first: ["/*"]` means **every** request goes through the Worker
first, not just `/api/*` — necessary since AB#7414 through AB#7418 layered on
live document/brand/presentation stamping, per-request theme and icon
overrides, and an installed-engine bundle that can live entirely in storage
rather than in the immutable asset snapshot the build shipped. The cost is
one Worker invocation per asset request; it's mitigated by a negative-result
cache (`installedEngine()` in `index.ts`) so a deployment with nothing
installed — the default — pays one in-memory check per request rather than a
storage read.

Azure has no native equivalent binding, so `server.mjs` reimplements the same
routing by hand, in the same precedence order, with `@hono/node-server/serve-static`
as the final fallback: `/admin` → `admin.html` (falling back to `index.html`
on an older build), `/`, `/sw.js`, `/theme.css`, `/icons/:name`,
`/manifest.webmanifest`, `/assets/:name` (installed-engine-aware), then static
files, then the SPA shell for anything else. See the annotated source in
`platforms/azure/server.mjs` for exactly which route claims which path and
why the order matters.

## Custom domains

| | App domain | Content domain |
|---|---|---|
| Required? | Yes — this is where the site is served. | **No, by default.** With `CONTENT_ORIGIN` empty (Cloudflare) or explicitly set to the app origin (Azure serves content off its own storage regardless), content is same-origin — `GET /manifest.json`/`GET /books/*` answer straight out of the bound storage. |
| Cloudflare setup | `routes: [{ pattern: "app.example.com", custom_domain: true }]` in the brand's `wrangler.jsonc` env. | Optional: an **R2 custom domain** attached to the content bucket, with `CONTENT_ORIGIN` set to match (e.g. `https://content.example.com`). Bypasses the Worker entirely for content requests — zero Worker invocations for chapter JSON, audio and art — at the cost of real DNS work (the domain must be in your Cloudflare zone). |
| Azure setup | App Service custom domain binding + your own TLS cert (or App Service Managed Certificate). | Blob Storage's own public endpoint, or a CDN/Front Door in front of it, with `CONTENT_ORIGIN` set accordingly. |
| Why bother with a separate content domain | Not needed for correctness — same-origin content is a fully supported, zero-DNS default. Worth it on a high-traffic site to keep chapter/audio/art requests off the Worker's free-tier invocation budget, or to put a different CDN/caching policy in front of content than in front of the app. | — |

See [`architecture.md`](architecture.md) for the request-volume budget math
behind that trade-off, and [`deploy-your-own.md`](deploy-your-own.md#3-provision-cloudflare-resources)
for the exact R2-custom-domain steps.

## Related

- [`deploy-your-own.md`](deploy-your-own.md) — the Cloudflare walkthrough:
  create a brand, add a `wrangler.jsonc` env, provision D1 + R2, set secrets,
  deploy, publish.
- [`deploy-azure.md`](deploy-azure.md) — the Azure walkthrough: region checks,
  `install.mjs --deploy`, what `infra.bicep` provisions.
- [`platforms/azure/README.md`](../platforms/azure/README.md) — running the
  Azure entry locally against real Azure resources, and how it differs
  internally from Cloudflare.
- [`upgrading.md`](upgrading.md) / [`updating.md`](updating.md) — how a
  deployment takes a new release once it exists.
- [`api.md`](api.md) — every route these bindings and secrets gate.
- [`architecture.md`](architecture.md) — the one-Worker-per-brand model and
  the free-tier budget.
