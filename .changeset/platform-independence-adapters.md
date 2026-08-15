---
'storylark-worker': minor
---

Database access now goes through a platform-agnostic Database interface
(`Database` + `ConflictInsert` in `src/db/types.ts`) instead of directly
against Cloudflare D1. The Cloudflare driver (`src/db/d1.ts`) is a zero-cost
identity wrapper — no behavior change for existing D1 deployments. A new
Postgres driver (`src/db/postgres.ts`) covers Azure Database for PostgreSQL
and AWS RDS/Aurora with one implementation, translating `?` placeholders
positionally and using `citext` for case-insensitive email/username lookups.

The three `INSERT OR IGNORE` call sites move to a portable `insertIgnore()`
helper — the only genuinely dialect-specific SQL, implemented once per
driver.

The package now also exports a raw `app` (the Hono instance with no
Cloudflare-specific wrapping) alongside the existing Cloudflare-only default
export, for platform entries that bind `env.DB` to a driver directly
(`platforms/azure/server.mjs`).

Migrations gained a Postgres-dialect mirror: `migrations-postgres/*.sql` plus
`migrate-postgres.mjs`, the Postgres equivalent of
`wrangler d1 migrations apply`.
