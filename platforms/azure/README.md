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

## Setup

1. Build the app for your brand from the repo root:
   ```
   npm run build -w app -- --mode <your-brand-id>
   ```
2. Copy `.env.example` to `.env` and fill in every value — see the comments
   in that file for what each one is.
3. Apply the database schema:
   ```
   npm run migrate
   ```
   (Runs `packages/worker/migrate-postgres.mjs` against `DATABASE_URL` —
   the Postgres-dialect mirror of `wrangler d1 migrations apply`.)
4. Start the server:
   ```
   npm start
   ```
   This serves the API under `/api/*` and the built app under everything
   else. In production, front this process with Azure App Service's own
   ingress (or Container Apps) — `STATIC_ROOT`/`PORT` are configurable via
   env vars for that.

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
