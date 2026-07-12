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

   publish (dev box / Actions): tools/publish.mjs
     markdown → blocks → Azure TTS (F0) → ffmpeg stitch → R2 → POST /api/admin/publish → web push
```

## Load-bearing decisions

- **One Worker per brand, one repo.** Brand is baked at build time (`vite build --mode <brand>`); zero runtime brand logic. Adding a brand = new `brands/<id>/` folder + wrangler env + bootstrap. No shared-code changes (Phase 9 acceptance test).
- **D1 per brand.** No cross-brand queries exist, so isolation beats a shared DB with a brand column.
- **Content on R2 custom domain, not through the Worker.** Audio bytes and Range requests never spend Worker CPU/requests; Cloudflare edge caches them; egress is free.
- **Cookie sessions (HttpOnly, SameSite=Lax).** App and API are same-origin, so cookies just work — including from the service worker. CSRF covered by the `X-Requested-With: storyreader` header requirement on mutations.
- **Payload-less web push.** The Worker only signs a VAPID JWT — no RFC 8291 encryption. The SW wakes, fetches the manifest, and composes the notification itself.
- **Publish-time TTS, not on-demand.** F0 is free but slow (20 req/min); narration is generated once per chapter revision and stored forever.

## Free-tier budget

| Resource | Limit | Our usage |
|---|---|---|
| Workers requests | 100k/day | API-only (assets are free) — small |
| Worker CPU | 10 ms | JSON + D1 queries only |
| D1 | 5M reads / 100k writes /day | progress writes debounced 30 s |
| R2 | 10 GB, zero egress | ~0.7 MB/min audio; monitor at scale |
| Azure Speech F0 | 500K chars/month | ledger in tools/.state, hard stop at 450K |
| Resend | 100 emails/day | magic links only |

See `docs/plan.md` for the full plan; per-topic details in the sibling docs.
