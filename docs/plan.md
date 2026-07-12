# StoryReader — Implementation Plan

> Approved technical plan (2026-07-06). This is the document of record for the build;
> the per-topic docs in this folder expand each section.

A free, installable PWA serving branded story libraries with read + listen (word-synced) modes, offline downloads, cross-device sync, and web push. One repo (`holdfast-press/storyreader`), deployed once per brand as a single Cloudflare Worker (static assets + API), backed by D1 + R2, with a publish-time TTS pipeline against Azure Speech F0.

## 1. Tech stack (decisions)

| Concern | Choice | Why |
|---|---|---|
| UI | **Preact 10 + @preact/signals** (via `preact` preset for Vite) | 3 screens but heavy reactive state (playback position, highlight index, download progress, sync status). Preact is ~4 KB gz, JSX, no build exotica. React not needed. |
| Build | **Vite 6 + TypeScript**, `vite-plugin-pwa` in **injectManifest** mode (hand-written `sw.ts`, plugin only generates the precache list) | Full control of caching logic; free precache manifest. |
| Worker | **One Cloudflare Worker per brand** using **Workers Static Assets** (`assets` binding, `run_worker_first: ["/api/*"]`) + **Hono 4** router for `/api/*` | Static-asset requests are free (don't count toward 100k/day); API stays thin. |
| Data | **D1, one database per brand** (`storyreader-holdfast`, `storyreader-gunner`) | Per-brand isolation; no cross-brand query ever exists. D1 free tier allows 10 DBs. |
| Content storage | **R2, one bucket per brand**, exposed via **R2 custom domain** `content.holdfastpress.com` / `content.gunnerthelab.com` with CORS allowing the app origin | Zero-egress, edge cache, native HTTP Range support (critical for audio seeking) without spending Worker requests/CPU. |
| Sessions | **HttpOnly cookie** (same-origin app + API) | Simpler and safer than bearer tokens; no token storage in JS. |
| Fonts | Self-hosted via `@fontsource/*` packages | Offline-capable, precached, no Google Fonts runtime dependency. |
| TTS pipeline | Node 22+ script (`tools/publish.mjs`) + `microsoft-cognitiveservices-speech-sdk` + ffmpeg | SDK delivers `WordBoundary` events during real-time synthesis, which works on **F0** (batch synthesis API requires S0 — do not use it). |

## 2. Repo structure

```
storyreader/
├─ package.json                  # workspaces: app, worker, tools
├─ wrangler.jsonc                # base + env.holdfast + env.gunner
├─ .github/workflows/deploy.yml  # matrix deploy per brand
├─ brands/{holdfast,gunner}/     # brand.json, theme.css, manifest template, assets/
├─ app/                          # Vite + Preact PWA
│  └─ src/
│     ├─ main.tsx  app.tsx  router.ts
│     ├─ screens/ Library.tsx  Reader.tsx  Settings.tsx
│     ├─ reader/  BlockRenderer.tsx  Highlighter.ts  AudioController.ts  SpeechFallback.ts
│     ├─ lib/     api.ts  db.ts (IndexedDB)  downloads.ts  progress-sync.ts  push.ts  mediasession.ts
│     ├─ sw.ts                   # service worker (injectManifest)
│     └─ styles/
├─ worker/
│  ├─ src/ index.ts  routes/  lib/  types.ts
│  └─ migrations/ 0001_init.sql
├─ tools/
│  ├─ publish.mjs  tts.mjs  stitch.mjs  r2-upload.mjs  gen-vapid.mjs
│  └─ parse/ holdfast.mjs  gunner.mjs
└─ docs/
```

Brand selection at build time: `--mode $BRAND` → Vite loads `brands/$BRAND/brand.json` and `theme.css`, emits `manifest.webmanifest`, copies icons. **No runtime brand switching** — each deployment is fully baked.

## 3. D1 schema

Tables: `users`, `oauth_identities`, `magic_links` (token **hash** only, 15-min expiry, one-time), `sessions` (hashed id, 30-day rolling), `progress` (PK user/book/chapter; `char_offset`, `audio_ms`, `percent`, `updated_at` for LWW), `bookmarks`, `push_subscriptions` (endpoint PK, `failed_count`), `library_state` (single row, `manifest_version`). See `worker/migrations/0001_init.sql`.

## 4. Worker API surface (all under `/api`, Hono)

| Method + path | Auth | Notes |
|---|---|---|
| `POST /api/auth/magic/request` `{email}` | — | Rate-limit 3/15min per email. Token = 32 random bytes b64url; store SHA-256; send via Resend. Always 200 (no enumeration). |
| `GET /api/auth/magic/verify?token=…` | — | Hash → lookup, one-time, upsert user, set session cookie, 302 → `/`. |
| `GET /api/auth/google` | — | 302 to Google, signed `state` + PKCE. |
| `GET /api/auth/google/callback` | — | Verify state, server-side code exchange, upsert identity+user, cookie, 302 → `/`. |
| `POST /api/auth/logout` | cookie | Delete session, clear cookie. |
| `GET /api/me` | cookie | `{user, sessionExpiresAt}` or 401. |
| `GET /api/progress` | cookie | Bulk pull. |
| `PUT /api/progress/:bookId/:chapterId` | cookie | **LWW** upsert (`ON CONFLICT DO UPDATE … WHERE excluded.updated_at > progress.updated_at`); returns winning row. |
| `GET/POST/DELETE /api/bookmarks…` | cookie | CRUD. |
| `POST /api/push/subscribe` / `unsubscribe` | optional | Upsert/delete by endpoint. |
| `GET /api/library/version` | — | `{version}` from `library_state`. |
| `POST /api/admin/publish` | `X-Admin-Key` | Bump version, fire web push to all subscriptions. |

Session cookie: `sr_session` — `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`. CSRF: JSON-only bodies + `X-Requested-With: storyreader` header on mutating routes.

Content is **not** served by the Worker — it comes from the R2 custom domain. Hashed paths → `Cache-Control: public, max-age=31536000, immutable`; `manifest.json` → `max-age=60`.

## 5. Content / R2 layout

```
content.<domain>/
├─ manifest.json                         # schemaVersion, libraryVersion, books[]
└─ books/<bookId>/
   ├─ book.json
   ├─ chapters/<id>.<hash8>.json         # structured blocks (see below)
   ├─ audio/<id>.<hash8>.mp3
   ├─ timings/<id>.<hash8>.json          # word offsets: [charStart,charEnd,startMs,endMs]
   └─ covers/
```

Chapter JSON block types: `paragraph` (with `spans` for em/strong), `scene-break`, `display-beat`, `message-block` (speaker/time/text), `end-marker`. Block IDs stable across republish (text-hash matching). Gunner: each story = one book with one chapter, grouped by `era` in the Library UI; covers copied into R2 (offline needs them local).

## 6. Publish pipeline — `tools/publish.mjs`

1. **Parse** brand markdown → blocks (holdfast: `---` scene break, standalone-italic display beat, `> **Name (time):**` message blocks, `*End of X*` marker; gunner: same rules over `src/content/stories/*.md`, skip drafts).
2. **Hash & skip**: `contentHash = sha256(canonicalJSON).slice(0,8)`; `tools/.state/<brand>.json` skips unchanged chapters; `--no-audio` reuses prior audio when word delta < 1%.
3. **TTS**: Azure Speech SDK per block, SSML with 900 ms breaks for scene breaks; collect wordBoundary events (`ms = ticks / 10000`); **F0 limits: 20 req/min → sleep 3.1 s between requests; 500K chars/month ledger in `.state`, abort at 450K.**
4. **Stitch**: ffprobe each chunk's actual duration → accumulate offsets → ffmpeg concat (stream copy).
5. **Upload**: `wrangler r2 object put` for chapter JSON, MP3, timings, covers; manifest **last**.
6. **Notify**: `POST /api/admin/publish` with `X-Admin-Key`.

Azure resource (one-time, F0): `az cognitiveservices account create -n storyreader-tts -g rg-storyreader --kind SpeechServices --sku F0 -l eastus --subscription thisismydemo --yes`

## 7. PWA / offline

Three SW cache tiers: (1) precache app shell; (2) runtime — SWR for manifest/covers, cache-first for hashed immutable JSON; (3) `downloads` — populated only by explicit user action; MP3 cached full-body and served with **local Range handling** so seek works offline. IndexedDB stores: progress mirror, offline `outbox` (replayed FIFO; LWW makes replay safe), downloads metadata, typography settings. Media Session API for lock-screen controls. iOS caveats documented in `docs/pwa-offline.md` (push requires installed PWA 16.4+, cache eviction → verify-on-load, keep one `<audio>` element alive across chapters).

## 8. Read-along sync

Only the **active block** gets word `<span>`s (lazy, from timings char offsets). rAF loop reads `audio.currentTime`, binary-searches word array, moves `.word-active`; block change re-centers via `scrollIntoView` unless user scrolled in last 5 s. Tap word → seek. Web Speech fallback for `hasAudio:false`: per-sentence on Chrome (long-utterance kill), paragraph-level highlight on iOS (unreliable boundary events).

## 9. Web Push

Separate VAPID keypair per brand; public key in `brand.json`, private = Worker secret. **Payload-less pushes** (no RFC 8291 encryption needed): Worker signs VAPID JWT (ES256 WebCrypto), empty body, `TTL: 86400`; SW `push` handler fetches `/api/library/version` + manifest and shows the notification. 404/410 → delete subscription; `failed_count` ≥ 5 → delete. iOS gate: require installed PWA before offering the toggle.

## 10. Auth

Magic link via Resend (holdfastpress.com domain already verified; **Gunner prerequisite: verify gunnerthelab.com in Resend before its launch**, or send from holdfastpress.com initially). Google OAuth: one client per brand, PKCE, server-side exchange, `openid email profile`. Account linking keys on verified email.

## 11. Deploy / DNS

Custom domains for Workers auto-create DNS + certs (both zones in account `5d8be56e…`). R2 custom domain per bucket with CORS `AllowedOrigins: [app origin]`, `AllowedMethods: [GET, HEAD]`, `AllowedHeaders: ["Range"]`. The existing holdfastpress.com/app marketing page is **never touched** — only new subdomain records.

One-time bootstrap per brand:

```
wrangler d1 create storyreader-<brand>
wrangler d1 migrations apply storyreader-<brand> --env <brand> --remote
wrangler r2 bucket create storyreader-<brand>-content
# attach content.<domain> + CORS to the bucket
node tools/gen-vapid.mjs
wrangler secret put VAPID_PRIVATE_KEY --env <brand>
wrangler secret put RESEND_API_KEY --env <brand>
wrangler secret put GOOGLE_CLIENT_ID --env <brand>
wrangler secret put GOOGLE_CLIENT_SECRET --env <brand>
wrangler secret put ADMIN_KEY --env <brand>
```

CI: `.github/workflows/deploy.yml`, matrix per brand, `wrangler-action` with `CLOUDFLARE_API_TOKEN` secret. Migrations applied via a separate manual-dispatch job.

## 12. docs/ set

architecture.md · content-pipeline.md · api.md · data-model.md · pwa-offline.md · read-along.md · auth.md · push.md · branding.md · deploy.md · engineering-roadmap.md

## 13. Phased implementation order

| Phase | Deliverable | Verification |
|---|---|---|
| 0 | Toolchain, repo scaffold, docs skeletons, brand configs | build emits themed shell |
| 1 | Parser + chapter JSON for prologue/chapter-one | blocks match live site rendering |
| 2 | Worker + D1 + static assets deployed to app.holdfastpress.com | `/api/library/version` → 200; installable shell |
| 3 | Auth (magic link + Google) + sessions | both flows work desktop + phone |
| 4 | Library + Reader (read mode) + progress sync | cross-device position matches; airplane-mode edits replay |
| 5 | TTS pipeline end-to-end for prologue | word boundaries ±150 ms at 3 spot-checks |
| 6 | Listen mode: player, highlighter, Media Session, Web Speech fallback | lock-screen controls; tap-word seek |
| 7 | Offline downloads + SW range serving | airplane mode: read AND play with seek |
| 8 | Web push + admin publish + new-content badge | notification on installed Android + iOS PWA |
| 9 | **Gunner launch (config-only)** | zero shared-code changes is the acceptance test |

## 14. Risks / limits

- **Azure F0 500K chars/month**: The Keepers chapters ≈ 40–50K chars each — fine. Gunner's 42-story backfill ≈ 1.5M+ chars → **batch over 3–4 months**; pipeline ledger enforces.
- **D1 free writes**: progress saves debounced to 30 s — negligible.
- **R2 10 GB**: 96 kbps ≈ 0.72 MB/min; comfortable.
- **iOS PWA**: push only when installed; background audio killable under memory pressure (progress saved every 30 s); Web Speech boundary events unreliable → paragraph fallback.
- **MP3 concat drift**: mitigated by ffprobe-measured durations; Phase 5 verifies alignment.
- **Stable block IDs**: text-hash matching; heavily edited chapter may reset mid-chapter progress (acceptable, documented).
- **Resend for Gunner**: verify gunnerthelab.com domain before Phase 9.
