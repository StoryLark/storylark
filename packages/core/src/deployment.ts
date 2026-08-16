/// <reference path="./virtual.d.ts" />
// Deployment config, resolved at runtime (AB#7414 — plan §0d Phase 1).
//
// Two layers, in this order:
//
//   1. What the platform serving this document injected, from ITS environment,
//      at response time — `self.__STORYLARK_DEPLOYMENT__`, written into the
//      `<head>` of index.html/admin.html and prepended to sw.js by
//      packages/worker/src/lib/deployment.ts (Cloudflare Worker) and
//      platforms/azure/server.mjs (Node).
//   2. What the build baked in — deployment/<id>/deployment.json, plus the
//      STORYLARK_* build-time overrides the installers use.
//
// Layer 2 is a FALLBACK, not the source of truth. It exists so the app still
// works where nothing injects: `vite dev`, `vite preview`, a plain static host,
// or a document served by a platform running an older engine mid-update. In a
// real deployment layer 1 always wins, which is what makes changing an app
// setting take effect without rebuilding the bundle.
//
// Per-key, not all-or-nothing: an injected object that omits `vapidPublicKey`
// leaves the built-in one in place. An unset environment variable must not
// blank out a value that was configured at build time.

import defaults from 'virtual:storylark-deployment';
import type { DeploymentConfig } from './lib/types';

/**
 * The global the serving platform writes.
 *
 * Keep in sync with DEPLOYMENT_GLOBAL in packages/worker/src/lib/deployment.ts.
 * Core deliberately does not import the worker package — the frontend must not
 * depend on the backend — so the name is spelled out in both places.
 */
export const DEPLOYMENT_GLOBAL = '__STORYLARK_DEPLOYMENT__';

/** `id` of the injected `<script>`. Same sync note as above. */
export const DEPLOYMENT_SCRIPT_ID = 'storylark-deployment';

function injected(): Partial<DeploymentConfig> | undefined {
  const value = (globalThis as unknown as Record<string, unknown>)[DEPLOYMENT_GLOBAL];
  return value !== null && typeof value === 'object' ? (value as Partial<DeploymentConfig>) : undefined;
}

/** True when this document/worker was served by a platform that injects. */
export const DEPLOYMENT_INJECTED: boolean = injected() !== undefined;

/** Resolve the live config. Exported for the service worker, which re-resolves. */
export function resolveDeployment(): DeploymentConfig {
  const live = injected() ?? {};
  return {
    appOrigin: live.appOrigin ?? defaults.appOrigin,
    contentOrigin: live.contentOrigin ?? defaults.contentOrigin,
    vapidPublicKey: live.vapidPublicKey ?? defaults.vapidPublicKey,
    tts: live.tts ?? defaults.tts,
  };
}

/**
 * This deployment's config. Read at module evaluation, which is safe because
 * the injected `<script>` sits in `<head>` ahead of the module bundle — no
 * extra round trip, nothing to await, and no flash of a wrongly-configured UI.
 */
export const DEPLOYMENT: DeploymentConfig = resolveDeployment();

/**
 * Re-stamp an HTML document with a given config.
 *
 * Used by the service worker on the app shell it serves out of the precache:
 * that copy carries whatever was injected the day it was cached, while the
 * service worker's own script is re-injected by the platform on every update
 * and therefore holds current values. Mirrors injectDeploymentIntoHtml in
 * packages/worker/src/lib/deployment.ts, and is a no-op on a document that
 * carries no injected tag (a static host, where the fallback already agrees).
 */
export function restampDeployment(html: string, config: DeploymentConfig): string {
  const re = new RegExp(`<script id="${DEPLOYMENT_SCRIPT_ID}">[\\s\\S]*?</script>`);
  if (!re.test(html)) return html;
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return html.replace(re, `<script id="${DEPLOYMENT_SCRIPT_ID}">self.${DEPLOYMENT_GLOBAL}=${json};</script>`);
}
