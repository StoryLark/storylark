# Changelog

## 0.8.0

### Minor Changes

- [`afddda2`](https://github.com/StoryLark/storylark/commit/afddda2af670a2201334b5e3c0461dd198d63d95) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Admin portal auth moves from a shared `ADMIN_KEY` header to database-backed
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

## 0.7.0

### Minor Changes

- [`2f3bac8`](https://github.com/StoryLark/storylark/commit/2f3bac8eeac6ef025be2bff9b4f0d963096a2001) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Self-update and admin portal (AB#7403, AB#7404). A new `/admin` screen
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

## 0.5.0

### Minor Changes

- [`8fed3b9`](https://github.com/StoryLark/storylark/commit/8fed3b9f86ad4dff03a9e7132ff11deab53c0a0d) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Read-along now holds a screen wake lock while narration is playing with the
  text on screen, controlled by a new "Keep screen awake" setting (on by
  default, shown only where the browser supports it, account-synced).
  Finishing a standalone story no longer auto-plays the next story by default:
  a new "Auto-play the next story" toggle in Settings → Playback (flat-library
  brands) makes continuing an explicit, account-synced choice. Chapters within
  a book always continue automatically.

## 0.4.0

### Minor Changes

- [`95e38e0`](https://github.com/StoryLark/storylark/commit/95e38e00711cb3ffb8f86dad44777c1426d34e16) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Traceable build identity. The app version shown in Settings/About is now storylark-core's real npm version (the hand-bumped APP_VERSION counter is gone), and About gains a "Version & build" section listing the version of every installed storylark-\* package plus the solution build's git commit, build time, and brand. The Vite preset injects this at build time via `virtual:storylark-build`. RELEASE-NOTES.md headings are now keyed to the same version number. worker/pipeline: expose `./package.json` in exports so build tooling can read their versions.

### Patch Changes

- [`60beb5f`](https://github.com/StoryLark/storylark/commit/60beb5fa54f86921ef6ac883aa8dad34d3b86fac) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Split the human-facing changelog from the Changesets-managed one: `CHANGELOG.md` is now
  Changesets' own file (auto-generated, don't hand-edit); curated release notes for the About
  screen and storylark.org now live in `RELEASE-NOTES.md`. App version bumped to 0.4.0 for the
  narrator voice picker; roadmap updated to reflect shipped npm packages and the voice picker,
  and to list the remaining M7 features and 1.0 hardening work.

<!-- Owned by Changesets — do not hand-edit. Human-facing release notes live in
     RELEASE-NOTES.md (imported by the About screen). -->

## 0.3.0

### Minor Changes

- [`20d2df7`](https://github.com/StoryLark/storylark/commit/20d2df751b4c4c458aa766731fe0a630fbe8dc26) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Narrator voice picker — a library can now offer multiple narrator voices.

  - Pipeline: `brand.json` `tts.voices` lists every voice the library ships;
    extras publish as per-voice audio + word-timing tracks (with automatic
    backfill for already-published chapters), and the manifest carries a
    `voices` map of display names.
  - App: a "Narrator" picker appears in Settings whenever the library publishes
    2+ voices; the choice is synced across devices, applies on the next play,
    and downloads keep the chosen narrator available offline. Older manifests
    without voices keep working unchanged.
