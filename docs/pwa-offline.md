# PWA & Offline

## Cache tiers (service worker `packages/core/src/sw.ts`)

| Cache | Filled by | Strategy |
|---|---|---|
| precache (`workbox`) | build (injectManifest) | App shell: JS/CSS/icons/HTML. New deploy = new precache, old cleaned up. The shell is re-stamped with the current deployment config and brand on its way out of the cache, so an installed app never serves a stale one. |
| `sr-runtime` | browsing | `manifest.json` + covers: stale-while-revalidate. Hashed chapter/timing JSON: cache-first (immutable). `theme.css`: network-first, cached only as the offline floor — a swapped brand must not survive in cache. Font files: cache-first, added the first time something renders in that family. |
| `sr-downloads` | the **Download button only** | Full copies of chapter text + timings + MP3 + any images the chapter references, for offline. |

Navigations fall back to the cached shell (SPA), so the app opens with no network.

## Offline audio seeking (the subtle part)

`<audio>` seeks by issuing HTTP **Range** requests, and Cache Storage can't answer
those. Downloads therefore store the *full* MP3 body, and the SW's fetch handler
slices it manually — synthesizing a `206 Partial Content` with correct
`Content-Range` — so scrubbing the timeline works in airplane mode exactly like online.

## Download lifecycle

1. Settings (or future long-press) → `downloadChapter`: fetches text + timings + audio full-body, `cache.put`s them, records bytes + content hash in IndexedDB.
   1a. **Images too.** The chapter JSON is also the manifest of its own art, so once the text is fetched its `image` blocks are walked and each distinct `src` is cached as well — a downloaded story shouldn't be missing its illustrations. Best-effort per image: art can live on an origin that sends no CORS headers, and an opaque response is one `cache.put` refuses, so a single unreachable image degrades to the alt text rather than failing the whole download. The service worker serves downloaded art from any origin, not just the content origin, and a book's images are cleared once none of its chapters are downloaded any more.
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
- Theme color and name come from the deployment's `brand.json` at request time,
  so the manifest follows a brand swap immediately; the icon *files* are
  build-time assets. An app that is **already installed** may keep its old
  home-screen name and icon until it is reinstalled — the operating system owns
  that copy of the manifest, and no web app can force it to update.
- The precached app shell carries the brand, deployment config and presentation
  that were injected the day it was cached, and the precache is only refetched
  when the *build* changes. The service worker therefore re-stamps all three into
  the shell on its way out of the cache, using its own copies — which are current
  because the platform re-injects `sw.js` on every fetch of it and serves it
  `no-store`. `brand.json` and `presentation.json` are deliberately **not**
  precached, since those are the files an operator swaps.
