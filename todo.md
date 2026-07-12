# StoryLark - todo

StoryLark is an open-source, self-hostable read-along storybook reader: a Vite + Preact
PWA, a Cloudflare Worker (API on D1 + R2), and a Markdown to JSON + TTS publish pipeline.
Clone it, configure a brand in `brands/`, and deploy your own. This repo is the app; the
marketing site lives in the `storylark.github.io` repo (storylark.org), and a live demo
runs at storylark.dev.

## Open tasks

### 1. Screen Awake setting (read-along) - not started
Keep the device screen awake in read-along mode via the Screen Wake Lock API.
- `navigator.wakeLock.request('screen')`, active ONLY in read-along (not listen-only, not
  app-wide); acquire on enter, release on leave, re-acquire on `visibilitychange`.
- Toggle on the Settings screen; the setting follows the user profile (per-profile, synced
  via the D1 worker), default off.
- Files: `app/src/screens/Settings.tsx`, `app/src/state.ts`, the read-along controller.

### 2. Genericize for public release - not started (do BEFORE flipping public)
This repo still carries the brand content it was copied from. Before making it public:
- Replace the `gunner` and `holdfast` brands under `brands/` with a single neutral
  `example` brand, and document how to add your own.
- Remove environment-specific config from `wrangler.jsonc` (Cloudflare account and resource
  identifiers, D1 database ids, custom domains, mail-from) and replace with placeholders.
- Rename internal identifiers from `storyreader` to `storylark` (package.json, the wrangler
  `name`, docs).
- Add a LICENSE (MIT or Apache-2.0 - owner decides) and a public README.
- Rebuild history fresh from the genericized tree before flipping public.

### 3. Demo and marketing (separate)
- storylark.dev: deploy this app as a public demo (a `demo` brand instance).
- storylark.org: build the marketing landing page in the `storylark.github.io` repo.
