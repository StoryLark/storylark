# StoryLark on Azure

Runs the same `storylark-worker` API used on Cloudflare, over plain Node via
[`@hono/node-server`](https://github.com/honojs/node-server) — Hono's
official Node adapter, used here because Hono ships no Azure Functions
adapter (its official adapters are Cloudflare, Deno, Bun, Vercel, Netlify,
and AWS Lambda). This runs on **Azure App Service** or **Azure Container
Apps** as a normal Node process.

## What you need

- An Azure subscription
- **Azure Database for PostgreSQL — Flexible Server** (the data layer:
  accounts, progress, sessions)
- **Azure Storage Account** with Blob Storage (the content layer: published
  chapters, audio, timings, covers)
- **Azure App Service** (Node 20+) or **Container Apps**, to run this process

This folder is deliberately **not** an npm workspace member — it installs
`storylark-worker` from the real npm registry, standalone, the same way any
customer's deployment would. (It used to be a workspace member; Oryx's App
Service build extracts a built `node_modules` to an absolute path and
re-symlinks it into place, which breaks npm workspaces' *relative*
symlinks — confirmed by a real deploy crashing with
`ERR_MODULE_NOT_FOUND: storylark-worker`.) Run `npm install` in this folder
before anything else here.

## Deploying to Azure App Service (the supported path)

`node install.mjs --deploy --yes` (see [`../../docs/deploy-azure.md`](../../docs/deploy-azure.md))
does the whole thing: provisions `infra.bicep`, applies the database
schema, builds the app for your brand, and zip-deploys the app code — one
command to a live URL.

## Running locally against real Azure resources

Useful for testing against a real Postgres/Blob before deploying, or for
debugging a deployed app's behavior locally.

1. `npm install` (this folder, once — see the workspace note above)
2. Build the app for your brand from the repo root:
   ```
   npm run build -w app -- --mode <your-brand-id>
   ```
3. Copy `.env.example` to `.env` and fill in every value — see the comments
   in that file for what each one is.
4. Apply the database schema:
   ```
   npm run migrate
   ```
   (Runs `packages/worker/migrate-postgres.mjs` against `DATABASE_URL` —
   the Postgres-dialect mirror of `wrangler d1 migrations apply`.)
5. Start the server:
   ```
   npm start
   ```
   This serves the API under `/api/*` and the built app under everything
   else. `STATIC_ROOT`/`PORT` are configurable via env vars.

## Publishing content

Point the pipeline at Azure Blob instead of the Cloudflare default:

```
node ../../packages/pipeline/publish.mjs --brand <your-id> \
  --source <path-to-your-content> --parser <your-parser.mjs> \
  --storage azure-blob
```

Requires `AZURE_STORAGE_CONNECTION_STRING` in the environment (same variable
this server reads). See `packages/pipeline/storage.mjs` for the storage
seam and `docs/content-pipeline.md` for the parser contract.

### Editing content from the admin portal

The same connection string turns on portal content editing — `infra.bicep`
already sets it as an app setting, so a site deployed by `install.mjs` has it.
On boot this server logs which storage driver it bound; with none it says so and
`/admin` can read the library but not edit it.

| Setting | Effect |
|---|---|
| `AZURE_STORAGE_CONNECTION_STRING` | Edit through Azure Blob. Container defaults to `<BRAND>-content`; override with `CONTENT_CONTAINER`. |
| `STORYLARK_LOCAL_CONTENT` | Edit through a directory on disk — the same layout `publish.mjs --local <dir>` produces. Takes precedence, and is how this path is developed and tested without a cloud account. |
| `CONTENT_REVISIONS` | Text revisions kept per chapter. Default 5. |
| `CONTENT_MAX_UPLOAD_BYTES` | Ceiling for an uploaded image. Default 8MB. |

Note that after a portal edit the chapter's narration is stale — this process
can't run the TTS model any more than a Worker can. Re-run the pipeline with
`--pull` to bring the portal's edits down and re-narrate. See
`docs/design/admin-content-editing.md`.

## Why this runs differently from Cloudflare

- **Database**: `postgresDatabase()` (`packages/worker/src/db/postgres.ts`)
  instead of D1 — same route code, different driver, selected here in
  `server.mjs`.
- **Storage**: the `azure-blob` pipeline driver instead of R2.
- **Runtime**: `@hono/node-server` instead of the Workers runtime. One
  polyfill is needed here that Cloudflare provides natively:
  `ExecutionContext.waitUntil()` (used for background push/email sends) has
  no Node equivalent, so `server.mjs` provides a minimal one that runs the
  promise and logs failures instead of throwing.

Your brand theme, presentation, and content are identical either way —
nothing about switching platforms touches `brands/<id>/`.
