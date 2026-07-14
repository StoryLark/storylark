import type { JSX } from 'preact';
import { needRefresh, applyUpdate } from '../lib/update';

/** Fixed, app-wide banner shown once a new service worker has installed and is waiting to take over. */
export function UpdateBanner(): JSX.Element | null {
  if (!needRefresh.value) return null;
  return (
    <button class="update-banner" onClick={applyUpdate}>
      <span class="update-banner-dot" aria-hidden="true" />
      New version ready. Tap to refresh.
    </button>
  );
}
