import { signal } from '@preact/signals';
import { registerSW } from 'virtual:pwa-register';

/** True once a new service worker has installed and is waiting to take over. */
export const needRefresh = signal(false);

// Installed PWAs (especially iOS) rarely get a fresh `index.html` load, which
// is the browser's normal cue to check for a new service worker — so we also
// poll on an interval and whenever the app comes back into view.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;

/** Registers the service worker and wires up the "new version" prompt. Call once, from main.tsx. */
export function initServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;

  updateSW = registerSW({
    onNeedRefresh() {
      needRefresh.value = true;
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      setInterval(() => void registration.update(), UPDATE_CHECK_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration.update();
      });
    },
  });
}

/** Activates the waiting service worker, which reloads the page once it takes control. */
export function applyUpdate(): void {
  needRefresh.value = false;
  void updateSW?.(true);
}
