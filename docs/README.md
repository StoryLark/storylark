# StoryLark Documentation

StoryLark is an open-source engine for building your own branded, installable
story-reading app — a fast PWA with synced neural-TTS narration, word-synced
read-along, offline downloads, and cross-device progress. Runs on Cloudflare
(Workers + D1 + R2) or Azure (App Service + PostgreSQL + Blob Storage) from
the same codebase.

> **Status: preview (0.x).** The engine boots and builds today under a neutral
> StoryLark base brand, but ships without bundled content — bring your own
> stories through the [content pipeline](content-pipeline.md). APIs and structure
> will change before 1.0.

## Install & Deploy

- **[Getting Started](getting-started.md)** — clone, install, `npm run dev` /
  `build` / `typecheck`, project layout, and how the brand "mode" works.
- **[Install](install.md)** — every way in: clone, `npm create storylark`, the
  setup wizard, and the one-command path.
- **[Deploy Your Own](deploy-your-own.md)** — stand up your own StoryLark site on
  Cloudflare: create a brand, configure Wrangler, provision D1 + R2, set secrets,
  deploy, and publish.
- **[Deploy to Azure](deploy-azure.md)** — the same, on Azure App Service +
  PostgreSQL + Blob Storage, with a Bicep infrastructure template.

## Customize

- **[Build Your Own Theme](build-your-own-theme.md)** — the *branding* layer:
  the full `theme.css` token contract (light + dark), every `brand.json` field,
  fonts, and icons.
- **[Build Your Own Presentation](build-your-own-presentation.md)** — the
  *structure* layer: what's configurable today (`layout`, `nouns`), the fixed app
  shell, and where presentation templates are headed.

## Content

- **[Authoring Stories](authoring-stories.md)** — the blessed markdown format:
  folder-per-book, chapter files, `book.json`.
- **[Publishing Stories](publishing-stories.md)** — the operator's guide: CLI
  publish (full pipeline, including narration) vs. the admin portal (browser
  upload, text-only).
- **[Content Pipeline](content-pipeline.md)** — the technical reference:
  source → `packages/pipeline/publish.mjs` → chapter JSON + neural TTS MP3 + word timings →
  storage → manifest. The parser contract, flags, incremental hashing, and local mode.
- **[Voices](voices.md)** — the free on-device tier vs. Azure premium, picking
  a narrator, adding more, cost and time expectations.

## Operate

- **[Admin Guide](admin-guide.md)** — running your site from `/admin`: status,
  updates, story upload.
- **[Updating](updating.md)** — how the built-in self-update works, from the
  operator's chair: what you'll see, what the click does, what never changes.

## Reference (design docs)

- **[Architecture](architecture.md)** — the one-Worker-per-brand model, content
  storage, and the free-tier budget.
- **[Infrastructure](design/infrastructure.md)** — deployment architecture,
  Cloudflare and Azure side by side, with a diagram.
- **[Content Flow](design/content-flow.md)** — the add-a-story pipeline end to
  end, with a diagram.
- **[Update Flow](design/update-flow.md)** — the self-update mechanism and why
  it's shaped the way it is, with a diagram.
- **[API Reference](api.md)** — every `/api/*` endpoint served by the Worker.
- **[Data Model](data-model.md)** — database tables, on-device IndexedDB stores,
  the content storage layout, and last-writer-wins sync.
- **[Auth](auth.md)** — password, passkeys, and the dormant magic-link / Google
  paths.
- **[Web Push](push.md)** — payload-less push notifications on new content.
- **[PWA & Offline](pwa-offline.md)** — cache tiers, offline audio seeking, and
  the download lifecycle.
- **[Read-Along](read-along.md)** — word-synced highlighting, tap-to-seek, and the
  Web Speech fallback.

## Project status

- **[Roadmap](../packages/core/ROADMAP.md)** — what's coming.
- **[Changelog](../packages/core/CHANGELOG.md)** — what's shipped.

---

Licensed under the [Apache License 2.0](../LICENSE).
