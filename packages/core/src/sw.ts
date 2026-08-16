/// <reference lib="webworker" />
/// <reference path="./virtual.d.ts" />
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

import { addPlugins, precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

import { BRAND, BRAND_INJECTED, restampBrand } from './brand';
import { PRESENTATION_INJECTED, STATED_PRESENTATION, restampPresentation } from './presentation';
import { DEPLOYMENT, DEPLOYMENT_INJECTED, restampDeployment } from './deployment';

// This deployment's content origin, read at script evaluation. The serving
// platform prepends `self.__STORYLARK_DEPLOYMENT__ = {…}` to this file
// (AB#7414), so the value is whatever the deployment's environment says right
// now, not what was baked at build. It has to be resolved synchronously: the
// fetch handler below decides whether to call respondWith() before it may
// await anything.
const CONTENT_ORIGIN = DEPLOYMENT.contentOrigin;
const DOWNLOAD_CACHE = 'sr-downloads';
const RUNTIME_CACHE = 'sr-runtime';

/** Where this app is served from — always right, whatever `appOrigin` says. */
const APP_ORIGIN = self.location.origin;

/**
 * The brand's stylesheet, served by the platform from dist/theme.css with the
 * live font selection appended (AB#7415). Deliberately NOT precached: the
 * precache is keyed to the build, so a precached theme would keep an installed
 * PWA on the brand it was installed with, which is the exact staleness Phase 2
 * exists to remove.
 */
const THEME_PATH = '/theme.css';

/** Font files. Hashed and immutable, so cache-first is safe and permanent. */
const FONT_RE = /\.(woff2?|ttf|otf)$/i;

// App shell — injected by vite-plugin-pwa at build time.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// The precached app shell carries the deployment config, the brand AND the
// presentation that were injected when it was cached, and the precache is only
// refetched when the BUILD changes — so on an installed PWA a changed origin, a
// swapped brand or a rearranged tab bar would otherwise stay invisible to the
// page indefinitely, even though this worker already knows about all three.
// Stamp the current values back into the shell on its way out of the cache.
//
// This worker's own copies are current because the platform re-injects sw.js on
// every fetch of it and serves it `no-store`, so the browser's update check
// picks up a changed brand or origin and installs a byte-different worker.
//
// Skipped entirely when nothing injected this script: then the page's
// build-time fallbacks and this worker's are the same values, and rewriting the
// document would only risk breaking a static host for no gain.
if (DEPLOYMENT_INJECTED || BRAND_INJECTED || PRESENTATION_INJECTED) {
  addPlugins([
    {
      async cachedResponseWillBeUsed({ cachedResponse }) {
        if (!cachedResponse) return cachedResponse;
        if (!(cachedResponse.headers.get('content-type') ?? '').includes('text/html')) return cachedResponse;
        const html = await cachedResponse.clone().text();
        let fresh = html;
        if (DEPLOYMENT_INJECTED) fresh = restampDeployment(fresh, DEPLOYMENT);
        if (BRAND_INJECTED) fresh = restampBrand(fresh, BRAND);
        // The STATED presentation, not the resolved one — writing this engine's
        // defaults into a cached document would let a stale copy of an old
        // default outlive the core update that changed it. See
        // restampPresentation.
        if (PRESENTATION_INJECTED) fresh = restampPresentation(fresh, STATED_PRESENTATION);
        if (fresh === html) return cachedResponse;
        return new Response(fresh, {
          status: cachedResponse.status,
          statusText: cachedResponse.statusText,
          headers: cachedResponse.headers,
        });
      },
    },
  ]);
}

// Stay in the `waiting` state until the page asks this worker to take over —
// only then do we skipWaiting(). Calling it unconditionally on install (the
// old behavior) activates every new deploy immediately and silently, which
// left workbox-window's install→waiting detection with nothing to observe
// and made the "new version available" prompt impossible to trigger.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Brand assets on the app's own origin (AB#7415). Checked before the content
  // origin because the two are the same host on a single-origin deployment.
  if (url.origin === APP_ORIGIN) {
    // Network-first, cache as the offline floor. Never stale-while-revalidate:
    // that would show the previous brand's colours for one whole launch after a
    // swap, and "the service worker must not serve a stale brand" is the point.
    // The cost is one small conditional-free request on a blocking stylesheet;
    // offline, the fetch fails immediately and the cache answers.
    if (url.pathname === THEME_PATH) {
      event.respondWith(networkFirst(event.request));
      return;
    }
    // Fonts are cached on demand rather than precached. The curated set ships
    // every family so a brand can switch to any of them without a rebuild —
    // precaching all of them would make every reader download six typefaces to
    // use one. A font only enters the cache once something actually renders in it.
    if (FONT_RE.test(url.pathname)) {
      event.respondWith(cacheFirst(event.request));
      return;
    }
  }

  // Story art that was taken offline with its chapter (AB#7421). Checked ahead
  // of the origin bail because an inline image is allowed to live anywhere the
  // markdown pointed at — art uploaded through the admin portal lands on the
  // content origin, but a site that references its own marketing images is
  // still a supported shape, and a downloaded chapter must not lose its
  // illustrations just because they came from next door. Narrow on purpose:
  // only image requests, and only ones already in the download cache, so this
  // costs nothing for everything else.
  if (event.request.destination === 'image' && url.origin !== CONTENT_ORIGIN && url.origin !== APP_ORIGIN) {
    event.respondWith(downloadedImageOrNetwork(event.request));
    return;
  }

  if (url.origin !== CONTENT_ORIGIN) return;

  if (url.pathname.includes('/audio/')) {
    event.respondWith(serveAudio(event.request));
  } else if (url.pathname.endsWith('manifest.json') || url.pathname.includes('/covers/')) {
    event.respondWith(staleWhileRevalidate(event.request));
  } else {
    // Hashed chapter/timings JSON — immutable, cache-first across both caches.
    event.respondWith(cacheFirst(event.request));
  }
});

/** A downloaded image wherever it lives, else the network. Never caches on the
 *  way past: only an explicit chapter download puts art in the download cache. */
async function downloadedImageOrNetwork(request: Request): Promise<Response> {
  const downloaded = await caches.match(request, { cacheName: DOWNLOAD_CACHE });
  return downloaded ?? fetch(request);
}

async function cacheFirst(request: Request): Promise<Response> {
  const downloaded = await caches.match(request, { cacheName: DOWNLOAD_CACHE });
  if (downloaded) return downloaded;
  const runtime = await caches.open(RUNTIME_CACHE);
  const cached = await runtime.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) void runtime.put(request, res.clone());
  return res;
}

/** Fresh if the network answers, the last good copy if it does not. */
async function networkFirst(request: Request): Promise<Response> {
  const runtime = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) void runtime.put(request, res.clone());
    return res;
  } catch {
    const cached = await runtime.match(request);
    if (cached) return cached;
    throw new Error(`storylark: ${request.url} is unavailable offline and was never cached.`);
  }
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const runtime = await caches.open(RUNTIME_CACHE);
  const cached = await runtime.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) void runtime.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached ?? ((await network) as Response);
}

/**
 * Audio: downloaded chapters are cached as full bodies. <audio> issues Range
 * requests when seeking, and Cache Storage doesn't understand Range — so we
 * slice the cached body ourselves and synthesize a 206.
 */
async function serveAudio(request: Request): Promise<Response> {
  const cached = await caches.match(request.url, { cacheName: DOWNLOAD_CACHE, ignoreSearch: false });
  if (!cached) return fetch(request);

  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) return cached.clone();

  const buf = await cached.clone().arrayBuffer();
  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!match) return cached.clone();
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), buf.byteLength - 1) : buf.byteLength - 1;
  if (start >= buf.byteLength) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buf.byteLength}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') ?? 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

// ---- Web push (payload-less): wake up, fetch the new manifest, notify. ----

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush());
});

async function handlePush(): Promise<void> {
  let title = `${BRAND.appName}: ${BRAND.name}`;
  let body = 'New content is available in the library.';
  try {
    const res = await fetch(`${CONTENT_ORIGIN}/manifest.json`, { cache: 'no-cache' });
    if (res.ok) {
      const manifest = (await res.json()) as {
        books: { title: string; chapters: { title: string; label?: string; publishedAt?: string }[] }[];
      };
      const chapters = manifest.books.flatMap((b) => b.chapters.map((c) => ({ ...c, book: b.title })));
      const latest = chapters.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))[0];
      if (latest) body = `${latest.label ? `${latest.label}: ` : ''}${latest.title}, ${latest.book}`;
      const runtime = await caches.open(RUNTIME_CACHE);
      void runtime.put(`${CONTENT_ORIGIN}/manifest.json`, res.clone());
    }
  } catch {
    // fall back to the generic body
  }
  await self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'new-content',
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => 'focus' in c);
      if (existing) return (existing as WindowClient).focus();
      return self.clients.openWindow('/');
    })
  );
});
