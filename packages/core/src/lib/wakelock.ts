// Screen wake lock for read-along or device-voice playback: while narration is
// playing with text on screen, or the visible PWA is supplying speech itself,
// the device must not dim or lock mid-story. Pre-recorded audio-only playback
// remains untouched when the Reader is not attached.
//
// Wake locks are auto-released by the browser whenever the page is hidden;
// the visibilitychange listener re-acquires on return if still wanted.

let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  if (!('wakeLock' in navigator) || sentinel || document.visibilityState !== 'visible') return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    // denied (low battery, browser policy) — reading continues without it
  }
}

/** Declare whether the wake lock should be held right now. Idempotent. */
export function setWakeLock(on: boolean): void {
  wanted = on;
  if (on) void acquire();
  else {
    void sentinel?.release().catch(() => undefined);
    sentinel = null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted) void acquire();
  });
}
