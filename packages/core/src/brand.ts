/// <reference path="./virtual.d.ts" />
import type { Brand, ContentNouns } from './lib/types';
import config from 'virtual:storylark-config';

/** Brand config baked in at build time from brands/<id>/brand.json. */
export const BRAND: Brand = config;

export function contentUrl(path: string): string {
  return `${BRAND.contentOrigin}/${path.replace(/^\//, '')}`;
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
