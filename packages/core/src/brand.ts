/// <reference path="./virtual.d.ts" />
// Brand identity, resolved at runtime (AB#7415 — plan §0d Phase 2).
//
// Two layers, in this order — the same shape Phase 1 gave deployment config:
//
//   1. What the platform serving this document injected, from the deployment's
//      OWN dist/brand.json, at response time — `self.__STORYLARK_BRAND__`,
//      written into the `<head>` of index.html/admin.html and prepended to
//      sw.js by packages/worker/src/lib/brand.ts (Cloudflare Worker) and
//      platforms/azure/server.mjs (Node).
//   2. What the build baked in — brands/<id>/brand.json, compiled into
//      `virtual:storylark-config`.
//
// Layer 2 is a FALLBACK. It exists so the app still works where nothing
// injects: `vite dev`, `vite preview`, a plain static host, or a document
// served by a platform running an older engine mid-update. On a real deployment
// layer 1 wins, which is what makes replacing dist/brand.json change the live
// site without rebuilding the bundle.
//
// Per-key, not all-or-nothing: an injected brand that omits `tagline` keeps the
// built-in one. A blank field in a hand-edited file must not wipe a value out.
//
// ── Where the boundary is, and why ──────────────────────────────────────────
// This module is IDENTITY, and only identity. `layout`, `nouns` and the rest of
// the §0b contract are PRESENTATION: they have their own file, their own
// injected global and their own resolver (./presentation.ts, AB#7416). They are
// not on `Brand` at all any more, so IDENTITY_KEYS below is no longer the only
// thing keeping them apart — the type is. An injected object carrying a
// `layout` still cannot reach BRAND through this function.

import type { Brand } from './lib/types';
import config from 'virtual:storylark-config';
import { DEPLOYMENT } from './deployment';

/**
 * The global the serving platform writes.
 *
 * Keep in sync with BRAND_GLOBAL in packages/worker/src/lib/brand.ts. Core
 * deliberately does not import the worker package — the frontend must not
 * depend on the backend — so the name is spelled out in both places.
 */
export const BRAND_GLOBAL = '__STORYLARK_BRAND__';

/** `id` of the injected `<script>`. Same sync note as above. */
export const BRAND_SCRIPT_ID = 'storylark-brand';

/** The identity a deployment may state. Everything else in `Brand` is baked. */
const IDENTITY_KEYS = [
  'id',
  'name',
  'appName',
  'shortName',
  'tagline',
  'author',
  'themeColor',
  'backgroundColor',
  'defaultTheme',
  'fonts',
] as const;

export type BrandIdentity = Partial<Pick<Brand, (typeof IDENTITY_KEYS)[number]>>;

/**
 * Just the identity keys of a brand — what a brand.json states, with the
 * build-only fields left off.
 *
 * The one extractor, used by restampBrand below and by the admin portal
 * (AB#7412), which has to hand the CURRENT identity back to the server when it
 * saves a presentation on a deployment that has nothing installed yet. Doing
 * that by hand at the call site would be a second list of which keys are
 * identity, and the first time the two disagreed a save would quietly drop a
 * tagline.
 */
export function brandIdentity(brand: Brand): BrandIdentity {
  const identity: BrandIdentity = {};
  for (const key of IDENTITY_KEYS) {
    const value = brand[key];
    if (value !== undefined) (identity as Record<string, unknown>)[key] = value;
  }
  return identity;
}

function injected(): BrandIdentity | undefined {
  const value = (globalThis as unknown as Record<string, unknown>)[BRAND_GLOBAL];
  return value !== null && typeof value === 'object' ? (value as BrandIdentity) : undefined;
}

/** True when this document/worker was served by a platform that injects. */
export const BRAND_INJECTED: boolean = injected() !== undefined;

/** Resolve the live brand. Exported for the service worker, which re-resolves. */
export function resolveBrand(): Brand {
  const live = injected();
  if (!live) return config;
  const resolved: Brand = { ...config };
  for (const key of IDENTITY_KEYS) {
    const value = live[key];
    if (value !== undefined) (resolved as unknown as Record<string, unknown>)[key] = value;
  }
  return resolved;
}

/**
 * This deployment's brand identity.
 *
 * Read at module evaluation, which is safe because the injected `<script>` sits
 * in `<head>` ahead of the module bundle — no extra round trip, nothing to
 * await, and no flash of the previous brand's name.
 *
 * For `layout`, `nouns` and everything else about the SHAPE of the library, see
 * ./presentation.ts. They were on this object until AB#7416.
 */
export const BRAND: Brand = resolveBrand();

export function contentUrl(path: string): string {
  return `${DEPLOYMENT.contentOrigin}/${path.replace(/^\//, '')}`;
}

/**
 * Re-stamp an HTML document with a given brand.
 *
 * Used by the service worker on the app shell it serves out of the precache:
 * that copy carries whatever brand was injected the day it was cached, while
 * the service worker's own script is re-injected by the platform on every
 * update and therefore holds the current one. Mirrors injectBrandIntoHtml in
 * packages/worker/src/lib/brand.ts, and is a no-op on a document that carries
 * no injected tag (a static host, where the fallback already agrees).
 *
 * The `<title>` is re-stamped too, for the same reason the injector writes it:
 * it is what the tab shows before any of this bundle has evaluated.
 */
export function restampBrand(html: string, brand: Brand): string {
  const re = new RegExp(`<script id="${BRAND_SCRIPT_ID}">[\\s\\S]*?</script>`);
  if (!re.test(html)) return html;
  const json = JSON.stringify(brandIdentity(brand)).replace(/</g, '\\u003c');
  return html
    .replace(re, `<script id="${BRAND_SCRIPT_ID}">self.${BRAND_GLOBAL}=${json};</script>`)
    .replace(/<title data-storylark-title="(app|admin)">[\s\S]*?<\/title>/, (match, kind: string) => {
      if (!brand.appName) return match;
      const title = kind === 'admin' ? `Admin — ${brand.appName}` : brand.appName;
      return `<title data-storylark-title="${kind}">${title
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</title>`;
    });
}
