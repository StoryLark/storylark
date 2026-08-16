# Architecture

```
                     ┌──────────────────────────────┐
   user ──────────── │  app.<brand>.com  (Worker)   │
                     │  ├─ static assets (free)     │
                     │  └─ /api/* → Hono + D1       │
                     └──────────────┬───────────────┘
                                    │ cookies, JSON
   ┌────────────────────────────────┴───┐
   │ content.<brand>.com (R2 custom     │   ← manifest.json, chapter JSON,
   │ domain, zero egress, edge cached,  │     MP3 audio, word timings, covers
   │ native Range support)              │
   └────────────────────────────────────┘

   publish (dev box / Actions): packages/pipeline/publish.mjs
     markdown → blocks → Azure TTS (F0) → ffmpeg stitch → R2 → POST /api/admin/publish → web push
```

## The three-layer package model

The codebase is an npm-workspaces monorepo publishing three packages:

| Package | Role |
|---|---|
| `storylark-core` | The PWA engine (screens, reader, player, sync, SW) plus the `defineStorylarkConfig` Vite preset. A site imports `mount()` and lets the preset own the build. |
| `storylark-worker` | The Hono API Worker. A site's worker entry is one line (`export { default } from 'storylark-worker'`); D1 migrations ship under `./migrations`. |
| `storylark-pipeline` | The publish pipeline as a site-agnostic CLI (`storylark-publish`) with an injected, site-owned content parser. |

A downstream site repo is *thin*: `index.html`, a 3-line `entry.ts`, a 5-line
`vite.config.ts`, a brand folder (theme), content, and wrangler config. The
in-repo `app/` folder is exactly that shape — the base site consuming the
packages the same way a deployer would. Theme, fonts, and config reach core
through virtual modules (`virtual:storylark-config` / `-theme.css` / `-fonts`)
provided by the preset, which is what makes `npm update storylark-core`
incapable of touching a site's theme or presentation. Releases are cut with
Changesets (see `.changeset/` and the Release workflow).

## Load-bearing decisions

- **One Worker per brand, one repo.** A build selects the brand (`vite build --mode <brand>`), but identity and theme leave the build as files the deployment serves and re-reads per request, so swapping them needs no rebuild ([design note](design/runtime-brand.md)). Adding a brand = new `brands/<id>/` folder + wrangler env + bootstrap. No shared-code changes (Phase 9 acceptance test).
- **D1 per brand.** No cross-brand queries exist, so isolation beats a shared DB with a brand column.
- **Content on R2 custom domain, not through the Worker.** Audio bytes and Range requests never spend Worker CPU/requests; Cloudflare edge caches them; egress is free.
- **Cookie sessions (HttpOnly, SameSite=Lax).** App and API are same-origin, so cookies just work — including from the service worker. CSRF covered by the `X-Requested-With: storylark` header requirement on mutations.
- **Payload-less web push.** The Worker only signs a VAPID JWT — no RFC 8291 encryption. The SW wakes, fetches the manifest, and composes the notification itself.
- **Publish-time TTS, not on-demand.** F0 is free but slow (20 req/min); narration is generated once per chapter revision and stored forever.

## Free-tier budget

| Resource | Limit | Our usage |
|---|---|---|
| Workers requests | 100k/day | API-only (assets are free) — small |
| Worker CPU | 10 ms | JSON + D1 queries only |
| D1 | 5M reads / 100k writes /day | progress writes debounced 30 s |
| R2 | 10 GB, zero egress | ~0.7 MB/min audio; monitor at scale |
| Azure Speech F0 | 500K chars/month | ledger in .storylark/state, hard stop at 450K |
| Resend | 100 emails/day | magic links only |

Per-topic details live in the sibling docs.
