# StoryLark Documentation

StoryLark is an open-source engine for building your own branded, installable
story-reading app — a fast PWA with synced neural-TTS narration, word-synced
read-along, offline downloads, and cross-device progress, running as a single
Cloudflare Worker over D1 and R2.

> **Status: preview (0.x).** The engine boots and builds today under a neutral
> StoryLark base brand, but ships without bundled content — bring your own
> stories through the [content pipeline](content-pipeline.md). APIs and structure
> will change before 1.0.

## Getting Started

- **[Getting Started](getting-started.md)** — clone, install, `npm run dev` /
  `build` / `typecheck`, project layout, and how the brand "mode" works.

## Deploy

- **[Deploy Your Own](deploy-your-own.md)** — stand up your own StoryLark site on
  Cloudflare: create a brand, configure Wrangler, provision D1 + R2, set secrets,
  deploy, and publish.

## Customize

- **[Build Your Own Theme](build-your-own-theme.md)** — the *branding* layer:
  the full `theme.css` token contract (light + dark), every `brand.json` field,
  fonts, and icons.
- **[Build Your Own Presentation](build-your-own-presentation.md)** — the
  *structure* layer: what's configurable today (`layout`, `nouns`), the fixed app
  shell, and where presentation templates are headed.

## Content

- **[Content Pipeline](content-pipeline.md)** — publish stories/chapters:
  source → `packages/pipeline/publish.mjs` → chapter JSON + neural TTS MP3 + word timings →
  R2 → manifest. The parser contract, flags, incremental hashing, and local mode.

## Reference (design docs)

- **[Architecture](architecture.md)** — the one-Worker-per-brand model, content
  on R2, and the free-tier budget.
- **[API Reference](api.md)** — every `/api/*` endpoint served by the Worker.
- **[Data Model](data-model.md)** — D1 tables, on-device IndexedDB stores, the
  R2 content layout, and last-writer-wins sync.
- **[Auth](auth.md)** — password, passkeys, and the dormant magic-link / Google
  paths.
- **[Web Push](push.md)** — payload-less push notifications on new content.
- **[PWA & Offline](pwa-offline.md)** — cache tiers, offline audio seeking, and
  the download lifecycle.
- **[Read-Along](read-along.md)** — word-synced highlighting, tap-to-seek, and the
  Web Speech fallback.

## Project status

- **[Roadmap](ROADMAP.md)** — what's coming.
- **[Changelog](CHANGELOG.md)** — what's shipped.

---

Licensed under the [Apache License 2.0](../LICENSE).
