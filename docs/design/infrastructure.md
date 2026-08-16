# Design: Infrastructure

Deployment architecture, Cloudflare and Azure side by side.

**Diagram:** [`infrastructure.drawio`](infrastructure.drawio) — open in
[app.diagrams.net](https://app.diagrams.net) or the draw.io desktop app. *No
PNG export is committed yet* (no headless draw.io renderer was available
when this was authored) — open the file once and export a PNG alongside it
per the documentation standard.

## The shape

Both platforms run the exact same route code (`packages/worker/src`). The
only thing that differs is which driver is bound underneath:

| Layer | Cloudflare | Azure |
|---|---|---|
| Runtime | Workers (`index.ts` default export) | Node via `@hono/node-server` (`platforms/azure/server.mjs`) |
| Database | D1 (`db/d1.ts` — zero-cost identity wrapper) | PostgreSQL Flexible Server (`db/postgres.ts`) |
| Storage | R2 (`r2-upload.mjs`) | Blob Storage (`storage-azure.mjs`) |
| Static assets | Workers Assets binding | Served by the same Node process |

## Why this split

The route handlers (`packages/worker/src/routes/*.ts`) only ever talk to
the `Database` interface (`db/types.ts`) and, on the pipeline side, the
storage seam (`packages/pipeline/storage.mjs`). Neither knows or cares
which platform it's running on. This is what makes "runs on Azure, not just
Cloudflare" true without a fork or a parallel codebase — one route file,
two drivers.

## What's platform-specific

- **Entry point** — `packages/worker/src/index.ts`'s default export
  (Cloudflare-only, wraps `env.DB` with the D1 driver) vs. the named `app`
  export that `server.mjs` binds directly to a Postgres-backed env.
- **Infrastructure provisioning** — `wrangler.jsonc` (Cloudflare) vs.
  `platforms/azure/infra.bicep` (Azure).
- **Static routing** — the reader app's SPA fallback and the `/admin` page are
  native asset-router behaviour on Cloudflare and explicit routes in
  `server.mjs` on Azure. Same observable result, two mechanisms; see
  [`standalone-admin.md`](standalone-admin.md).
- **Background work keep-alive** — Cloudflare's `ExecutionContext.waitUntil`
  is native; Azure's App Service process stays warm on its own (Always On),
  so `server.mjs` provides a small polyfill with the same shape.

See [`deploy-your-own.md`](../deploy-your-own.md) and
[`deploy-azure.md`](../deploy-azure.md) for the operational steps.
