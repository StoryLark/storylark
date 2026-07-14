/// <reference lib="webworker" />
/// <reference path="./virtual.d.ts" />
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

import BRAND from 'virtual:storylark-config';

const CONTENT_ORIGIN = BRAND.contentOrigin;
const DOWNLOAD_CACHE = 'sr-downloads';
const RUNTIME_CACHE = 'sr-runtime';

// App shell — injected by vite-plugin-pwa at build time.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

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
  if (url.origin !== CONTENT_ORIGIN || event.request.method !== 'GET') return;

  if (url.pathname.includes('/audio/')) {
    event.respondWith(serveAudio(event.request));
  } else if (url.pathname.endsWith('manifest.json') || url.pathname.includes('/covers/')) {
    event.respondWith(staleWhileRevalidate(event.request));
  } else {
    // Hashed chapter/timings JSON — immutable, cache-first across both caches.
    event.respondWith(cacheFirst(event.request));
  }
});

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
