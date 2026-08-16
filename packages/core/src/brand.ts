/// <reference path="./virtual.d.ts" />
import type { Brand, ContentNouns } from './lib/types';
import config from 'virtual:storylark-config';
import { DEPLOYMENT } from './deployment';

/**
 * Brand identity + presentation, baked in at build time from
 * brands/<id>/brand.json and presentation/<id>/presentation.json.
 *
 * Baked is correct for these: they are what the site IS, and changing them is
 * a rebuild by definition (theme.css, icons and the PWA manifest all change
 * with them). Making brand data runtime is plan §0d Phase 2, separately. What
 * is NOT here any more is anything about where this copy of the site lives —
 * that is DEPLOYMENT, resolved at runtime (AB#7414).
 */
export const BRAND: Brand = config;

export function contentUrl(path: string): string {
  return `${DEPLOYMENT.contentOrigin}/${path.replace(/^\//, '')}`;
}

/**
 * Brand content nouns — what a content unit is called in the UI, taken straight
 * from the brand config (see ContentNouns in lib/types). Every user-visible
 * string uses these instead of hardcoding "story"/"chapter"/"book".
 */
export const NOUNS: ContentNouns = BRAND.nouns;

/** "3 chapters" / "1 story" — count with the right brand noun. */
export function countUnits(n: number): string {
  return `${n} ${n === 1 ? NOUNS.unit : NOUNS.unitPlural}`;
}
