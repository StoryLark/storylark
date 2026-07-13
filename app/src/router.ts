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
}

window.addEventListener('popstate', () => {
  route.value = parse(location.pathname + location.search);
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
  return { name: 'home' };
}
