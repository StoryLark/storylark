import { signal } from '@preact/signals';

export type Route =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'book'; bookId: string }
  | { name: 'now-playing' }
  | { name: 'reader'; bookId: string; chapterId: string; mode?: 'read' | 'both' }
  | { name: 'settings' }
  | { name: 'about' };

export const route = signal<Route>(parse(location.pathname + location.search));

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  route.value = parse(path);
  requestAnimationFrame(() => document.getElementById('main-content')?.focus());
}

window.addEventListener('popstate', () => {
  route.value = parse(location.pathname + location.search);
  requestAnimationFrame(() => document.getElementById('main-content')?.focus());
});

function parse(path: string): Route {
  const url = new URL(path, location.origin);
  const p = url.pathname;
  const read = p.match(/^\/read\/([^/]+)\/([^/]+)\/?$/);
  if (read) {
    const m = url.searchParams.get('mode');
    return {
      name: 'reader',
      bookId: decodeURIComponent(read[1]),
      chapterId: decodeURIComponent(read[2]),
      mode: m === 'both' ? 'both' : m === 'read' ? 'read' : undefined,
    };
  }
  const book = p.match(/^\/library\/([^/]+)\/?$/);
  if (book) return { name: 'book', bookId: decodeURIComponent(book[1]) };
  if (p.startsWith('/library')) return { name: 'library' };
  if (p.startsWith('/now-playing')) return { name: 'now-playing' };
  if (p.startsWith('/settings')) return { name: 'settings' };
  if (p.startsWith('/about')) return { name: 'about' };
  // No '/admin' route on purpose (AB#7404): admin is its own page and its own
  // bundle now (admin.html / src/admin-entry.tsx), served by the platform
  // before this app ever loads. Nothing in the reader links to it, and a
  // hand-typed /admin is a full document load, so this router never sees it.
  return { name: 'home' };
}
