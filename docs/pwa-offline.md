# PWA & Offline

## Cache tiers (service worker `app/src/sw.ts`)

| Cache | Filled by | Strategy |
|---|---|---|
| precache (`workbox`) | build (injectManifest) | App shell: JS/CSS/fonts/icons/HTML. New deploy = new precache, old cleaned up. |
| `sr-runtime` | browsing | `manifest.json` + covers: stale-while-revalidate. Hashed chapter/timing JSON: cache-first (immutable). |
| `sr-downloads` | the **Download button only** | Full copies of chapter text + timings + MP3 for offline. |

Navigations fall back to the cached shell (SPA), so the app opens with no network.

## Offline audio seeking (the subtle part)

`<audio>` seeks by issuing HTTP **Range** requests, and Cache Storage can't answer
those. Downloads therefore store the *full* MP3 body, and the SW's fetch handler
slices it manually — synthesizing a `206 Partial Content` with correct
`Content-Range` — so scrubbing the timeline works in airplane mode exactly like online.

## Download lifecycle

1. Settings (or future long-press) → `downloadChapter`: fetches text + timings + audio full-body, `cache.put`s them, records bytes + content hash in IndexedDB.
2. On every app start the records are **re-verified against the actual cache** — iOS evicts under storage pressure, and a download that silently vanished must show as not-downloaded, honestly.
3. Remove deletes cache entries + the record. Total usage shown in Settings.
4. A republished chapter gets a new hash → old download keeps working until the user re-downloads (the manifest points at new files; the reader falls back to network for those).

## Reading position offline

Positions always write to IndexedDB first and queue in the outbox; the outbox drains
on reconnect/app-focus. Last-writer-wins server-side makes replay order irrelevant
(see `data-model.md`).

## Install & iOS notes

- Installable on Android/desktop (manifest + SW + icons); iOS via Share → Add to Home Screen.
- iOS kills background audio if the page is evicted — the app keeps ONE `<audio>` element alive across chapters (never recreated), and positions save every 30 s so recovery is cheap.
- Theme color / icons / name are per-brand, baked at build time.
