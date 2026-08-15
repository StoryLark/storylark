---
'storylark-core': minor
'storylark-worker': minor
---

Self-update and admin portal (AB#7403, AB#7404). A new `/admin` screen
(admin-key gated, key held in localStorage) shows the running engine
version against the latest published release, with an "Install update"
button that dispatches the site's own `self-update.yml` GitHub Actions
workflow — the click is the approval; nothing updates without it, and the
updater can only ever touch pinned engine versions, never a brand's theme
or presentation config. The portal also has a status view (library size,
push subscriber count) and a text story-upload form that commits markdown
via the GitHub Contents API and dispatches `publish.yml`, running the
real, unchanged publish pipeline rather than a second copy of its logic.

New worker routes: `GET /api/admin/status`, `GET /api/admin/update-status`,
`POST /api/admin/update-install`, `POST /api/admin/publish-story`. A
scheduled check (Cloudflare Cron Trigger / Azure interval) can also email
the operator proactively when RESEND_API_KEY and ADMIN_EMAIL are set — all
optional, everything degrades cleanly without these secrets configured.
