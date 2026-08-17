import { sendMail } from './resend';
import { readActiveEngine } from './engine-store';
import type { ContentStore } from './content-store';
import workerPkg from '../../package.json';

/**
 * Operator notification (AB#7403/F2): proactive half of self-update — the
 * operator hears about a new release without opening the admin portal.
 * Shared between Cloudflare's scheduled() handler (cron trigger) and
 * Azure's setInterval loop (server.mjs) so both platforms notify the same
 * way. Silently no-ops without RESEND_API_KEY + ADMIN_EMAIL configured —
 * this is a nice-to-have on top of the always-available in-portal check,
 * never a hard requirement.
 */
export async function checkForUpdateAndNotify(env: {
  APP_NAME: string;
  RESEND_API_KEY?: string;
  ADMIN_EMAIL?: string;
  CONTENT_STORE?: ContentStore;
}): Promise<{ checked: boolean; hasUpdate: boolean; notified: boolean }> {
  let latest: string;
  let coreLatest: string | undefined;
  try {
    const res = await fetch('https://registry.npmjs.org/storylark-worker/latest');
    if (!res.ok) return { checked: false, hasUpdate: false, notified: false };
    latest = ((await res.json()) as { version: string }).version;
    // The core check is best-effort on top: a core-only release (worker
    // unchanged) is exactly what the engine store can install with no redeploy,
    // so it deserves the same nudge — but a registry hiccup on this second read
    // must not silence the worker comparison that has always worked.
    const coreRes = await fetch('https://registry.npmjs.org/storylark-core/latest').catch(() => null);
    if (coreRes?.ok) coreLatest = ((await coreRes.json()) as { version: string }).version;
  } catch {
    return { checked: false, hasUpdate: false, notified: false };
  }

  // The engine actually being served, when an installed one states it. Without
  // one the build's core version is unknowable from here, and the worker
  // comparison (the pre-AB#7418 behaviour) is the honest fallback.
  let coreUpdate = false;
  let coreCurrent: string | undefined;
  if (coreLatest && env.CONTENT_STORE) {
    const active = await readActiveEngine(env.CONTENT_STORE).catch(() => null);
    if (active) {
      coreCurrent = active.coreVersion;
      coreUpdate = coreLatest !== active.coreVersion;
    }
  }

  const hasUpdate = latest !== workerPkg.version || coreUpdate;
  if (!hasUpdate) return { checked: true, hasUpdate: false, notified: false };
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return { checked: true, hasUpdate: true, notified: false };

  // Name the pair that actually moved: for a core-only release the worker
  // versions are equal, and "0.17.0 → 0.17.0" would be a baffling email.
  const [current, next] =
    latest !== workerPkg.version ? [workerPkg.version, latest] : [coreCurrent ?? workerPkg.version, coreLatest ?? latest];
  const notified = await sendMail(
    env.RESEND_API_KEY,
    `${env.APP_NAME} <noreply@storylark-updates.local>`,
    env.ADMIN_EMAIL,
    `${env.APP_NAME}: StoryLark ${next} is available`,
    updateEmail(env.APP_NAME, current, next)
  ).catch(() => false);

  return { checked: true, hasUpdate: true, notified };
}

function updateEmail(appName: string, current: string, latest: string): string {
  return `<!doctype html>
<body style="font-family: Georgia, serif; background:#f4f0e6; padding:32px; color:#23262d;">
  <div style="max-width:480px; margin:0 auto; background:#fbf8f1; border:1px solid #d8d1c0; border-radius:8px; padding:32px;">
    <h1 style="font-size:20px; margin:0 0 16px;">${appName}</h1>
    <p>A new StoryLark engine release is available: <strong>${current} → ${latest}</strong>.</p>
    <p style="margin:24px 0;"><a href="https://storylark.org/docs/changelog.html" style="color:#8C4420;">Release notes</a></p>
    <p>Open your site's <code>/admin</code> page to review and install — nothing updates without your approval.</p>
  </div>
</body>`;
}
