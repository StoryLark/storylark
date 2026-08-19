# StoryLark

**Read it. Hear it. Carry it with you.**

StoryLark is an open-source engine for building your own branded, installable
story-reading app. It serves a story library as a fast Progressive Web App (PWA)
with synced narration, offline downloads, and cross-device progress, and it runs
as a single [Cloudflare Worker](https://developers.cloudflare.com/workers/) backed
by D1 and R2.

> **Status: 1.0 release candidate.** The public contracts are frozen for 1.0.0;
> see the [stability policy](docs/stability.md) for the supported surface and
> compatibility promise. The base brand ships without publisher content, so a
> publisher still brings its own stories through the pipeline.

## Features

- **Read mode** — clean, typographically careful chapter reading.
- **Listen mode** — pre-generated neural TTS narration with word-synced read-along
  highlighting (Web Speech API fallback).
- **Offline** — download chapters (text + audio) for airplane mode.
- **My Library** — optionally add a PDF, Word or text document, pasted text, or
  an accessible web page. Personal items stay in that browser's local storage.
- **Sync** — sign in (email + password, magic link, passkeys, or Google) and continue
  on any device.
- **Push** — get notified when new chapters publish.
- **Themeable** — a per-brand `brand.json` + `theme.css` token contract drives the
  entire look, so one codebase powers many distinct, branded reading apps.

## Layout

```
brands/             — per-brand identity: brand.json, theme.css, manifest template, icons
presentation/       — per-brand shape: presentation.json (layout, nouns)
deployment/         — per-install config: deployment.json (origins, VAPID public key, TTS)
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

For a publisher site, use the standalone npm scaffold (it installs exact
compatible packages and records provenance for you):

```
npm create storylark my-site -- --deploy
```

Run `npm create storylark my-site` without `--deploy` to brand and inspect it
first, then use `npm run doctor` and `npm run setup`. Clone this repository only
when you are developing or forking the StoryLark engine itself.

Each deployed site has:

1. Add a brand under `brands/<id>/` (`brand.json` for identity, `theme.css` for the
   visual tokens, plus manifest + icons), its shape in `presentation/<id>/`, and its
   origins/TTS/VAPID public key in `deployment/<id>/`.
2. Provision the per-brand Cloudflare resources (D1 database, R2 bucket, secrets, custom
   domains) and point the brand's `wrangler` env at them.
3. Publish your stories through `packages/pipeline/publish.mjs` and deploy the Worker.

See [`docs/`](docs/) for the API, data model, auth, and read-along details. The
[`brands/storylark/`](brands/storylark/) base brand is the reference to copy when
starting your own.

## License

Licensed under the [Apache License 2.0](LICENSE).
