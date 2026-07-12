# StoryReader

**Read it. Hear it. Carry it with you.**

StoryReader is a free, installable PWA that serves branded story libraries with:

- **Read mode** — clean, typographically careful chapter reading
- **Listen mode** — pre-generated neural TTS narration with word-synced read-along highlighting (Web Speech API fallback)
- **Offline** — download chapters (text + audio) for airplane mode
- **Sync** — sign in (email magic link or Google), continue on any device
- **Push** — get notified when new chapters publish

One codebase, deployed once per brand as a single Cloudflare Worker (static assets + API), backed by D1 + R2:

| Brand | App | Content |
|---|---|---|
| Holdfast Press | app.holdfastpress.com | content.holdfastpress.com |
| Gunner the Lab | app.gunnerthelab.com | content.gunnerthelab.com |

## Layout

```
brands/     — per-brand config: brand.json, theme.css, manifest template, icons
app/        — Vite + Preact PWA (library / reader / settings)
worker/     — Cloudflare Worker: Hono API (/api/*) + static assets
tools/      — publish pipeline: markdown → chapter JSON + TTS audio + word timings → R2
docs/       — architecture and design docs (start with docs/plan.md)
```

## Quick start

```
npm install
npm run dev:holdfast        # Vite dev server + wrangler dev
npm run build:holdfast
npm run deploy:holdfast
npm run publish:holdfast -- --book the-keepers
```

See `docs/deploy.md` for the one-time per-brand bootstrap (D1, R2, secrets, DNS).
