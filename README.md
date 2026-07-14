# StoryLark

**Read it. Hear it. Carry it with you.**

StoryLark is an open-source engine for building your own branded, installable
story-reading app. It serves a story library as a fast Progressive Web App (PWA)
with synced narration, offline downloads, and cross-device progress, and it runs
as a single [Cloudflare Worker](https://developers.cloudflare.com/workers/) backed
by D1 and R2.

> **Status: preview (0.x).** The engine boots and builds today under a neutral
> StoryLark base brand, but ships without bundled content (bring your own stories
> through the pipeline). APIs and structure will change before 1.0. See
> [`packages/core/ROADMAP.md`](packages/core/ROADMAP.md) for the roadmap.

## Features

- **Read mode** — clean, typographically careful chapter reading.
- **Listen mode** — pre-generated neural TTS narration with word-synced read-along
  highlighting (Web Speech API fallback).
- **Offline** — download chapters (text + audio) for airplane mode.
- **Sync** — sign in (email + password, magic link, passkeys, or Google) and continue
  on any device.
- **Push** — get notified when new chapters publish.
- **Themeable** — a per-brand `brand.json` + `theme.css` token contract drives the
  entire look, so one codebase powers many distinct, branded reading apps.

## Layout

```
brands/             — per-brand config: brand.json, theme.css, manifest template, icons
app/                — the base site: a thin consumer of storylark-core
packages/core/      — storylark-core: the PWA engine + the defineStorylarkConfig Vite preset
packages/worker/    — storylark-worker: Cloudflare Worker — Hono API (/api/*) + static assets
packages/pipeline/  — storylark-pipeline: markdown -> chapter JSON + TTS audio + word timings -> R2
docs/               — technical docs (API, architecture, auth, data model, PWA/offline, read-along)
```

## Quick start

Requires Node.js 20+ and a Cloudflare account (for `wrangler dev`).

```
npm install
npm run dev          # build the app + wrangler dev (StoryLark base brand)
npm run build        # production build
npm run typecheck    # app + worker type checks
```

The app boots as a branded but empty shelf until you publish content. The publish
pipeline turns markdown into chapter JSON + narrated audio + word timings and uploads
them to R2:

```
npm run publish      # node packages/pipeline/publish.mjs --brand storylark
```

## Build your own branded app

StoryLark is designed to be deployed once per brand from the same codebase:

1. Add a brand under `brands/<id>/` (`brand.json` for identity/origins/TTS, `theme.css`
   for the visual tokens, plus manifest + icons).
2. Provision the per-brand Cloudflare resources (D1 database, R2 bucket, secrets, custom
   domains) and point the brand's `wrangler` env at them.
3. Publish your stories through `packages/pipeline/publish.mjs` and deploy the Worker.

See [`docs/`](docs/) for the API, data model, auth, and read-along details. The
[`brands/storylark/`](brands/storylark/) base brand is the reference to copy when
starting your own.

## License

Licensed under the [Apache License 2.0](LICENSE).
