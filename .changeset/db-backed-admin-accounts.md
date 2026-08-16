---
'storylark-worker': minor
'storylark-core': minor
---

Admin portal auth moves from a shared `ADMIN_KEY` header to database-backed
accounts (AB#7404).

`/admin` is now gated by a normal account in the app's own `users` table
carrying a new `is_admin` flag — same email+password, same session cookie,
and same emailed password reset any reader gets. The portal no longer asks
for, stores, or sends an admin key.

Getting the first account, and getting back in:

- The installer prints a one-time setup link plus ten recovery codes at the
  end of a successful deploy.
- Three recovery doors: the ordinary forgot-password email (works on admin
  accounts with no special-casing), a printed recovery code, or — last
  resort — re-minting a setup link with the deployment's `ADMIN_KEY`.

New routes: `POST /api/admin/setup/reset`, `POST /api/admin/setup/claim`,
`POST /api/admin/recover`. `GET /api/auth/me` now returns `isAdmin`.

Migration `0007_admin_accounts.sql` (both dialect trees) adds `users.is_admin`
plus the `admin_setup_tokens` and `admin_recovery_codes` tables.

**Breaking:** `GET /api/admin/status`, `GET /api/admin/update-status`,
`POST /api/admin/update-install`, and `POST /api/admin/publish-story` no
longer accept an `x-admin-key` header — they require an admin session.
`POST /api/admin/publish` still accepts the key, because the publish
pipeline calls it headless from CI, and `POST /api/admin/setup` still does
too, because it runs before any account can exist.
