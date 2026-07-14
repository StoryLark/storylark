import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { BRAND } from '../brand';

// Dismissible but recurring: dismissal only lasts the current session, so the
// notice quietly returns the next time the app opens.
const KEY = 'sr-preview-dismissed';

export function PreviewBanner(): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(KEY) === '1');
  if (dismissed) return null;
  return (
    <aside class="preview-banner" role="note">
      <div class="preview-banner-body">
        <strong>{BRAND.appName} is in preview.</strong> We're still building, so the occasional feature may misbehave. Thanks for
        reading with us while we finish the shelves.
      </div>
      <button
        class="preview-banner-close"
        aria-label="Dismiss preview notice"
        onClick={() => {
          sessionStorage.setItem(KEY, '1');
          setDismissed(true);
        }}
      >
        ×
      </button>
    </aside>
  );
}
