# Architecture

```
                     ┌──────────────────────────────┐
   user ──────────── │  app.<brand>.com  (Worker)   │
                     │  ├─ app assets / engine      │
                     │  └─ /api/* → Hono + D1       │
                     └──────────────┬───────────────┘
                                    │ cookies, JSON
   ┌────────────────────────────────┴───┐
   │ content.<brand>.com (R2 custom     │   ← manifest.json, chapter JSON,
   │ domain, zero egress, edge cached,  │     MP3 audio, word timings, covers
   │ native Range support)              │
   └────────────────────────────────────┘

   publish (dev box / Actions): packages/pipeline/publish.mjs
     markdown → blocks → bundled Kokoro or Azure TTS → ffmpeg stitch → R2 → manifest
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

- **One deployment per publisher brand.** A generated publisher site pins the
  engine packages and owns its brand, presentation, deployment config, and
  content. Runtime brand/theme/presentation overrides are stored separately
  from engine assets, so an engine update cannot overwrite them.
- **D1 per brand.** No cross-brand queries exist, so isolation beats a shared DB with a brand column.
- **Content on an R2 custom domain, not through the Worker.** Audio bytes and
  Range requests never spend Worker CPU/requests; Cloudflare edge caches them;
  R2 egress is free. App assets are different: `run_worker_first: ["/*"]`
  deliberately lets the Worker select an installed engine version before
  falling back to the built-in static asset. This is what makes **Update now**
  work without rebuilding a site.
- **Cookie sessions (HttpOnly, SameSite=Lax).** App and API are same-origin, so cookies just work — including from the service worker. CSRF covered by the `X-Requested-With: storylark` header requirement on mutations.
- **Payload-less web push.** The Worker only signs a VAPID JWT — no RFC 8291 encryption. The SW wakes, fetches the manifest, and composes the notification itself.
- **Publish-time TTS, not on-demand.** F0 is free but slow (20 req/min); narration is generated once per chapter revision and stored forever.

## Free-tier budget

| Resource | Limit | Our usage |
|---|---|---|
| Workers requests | 100k/day | App assets and API requests both traverse the Worker; cache and monitor real traffic |
| Worker CPU | 10 ms/request | Static fallback is light; API, Admin, and update routes do real work |
| D1 | 5M reads / 100k writes /day | progress writes debounced 30 s |
| R2 Standard | 10 GB-month, 1M Class A and 10M Class B operations/month; zero egress | Narration audio dominates storage; monitor reads and writes as the library grows |
| Azure Speech F0 | 500K chars/month | ledger in .storylark/state, hard stop at 450K |
| Resend | 100 emails/day | magic links only |

Limits are platform limits, not a guarantee that every deployment remains
free. Check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) before estimating a
production audience; the numbers above were verified in August 2026. Per-topic
StoryLark details live in the sibling docs.
