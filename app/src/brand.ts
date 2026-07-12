import type { Brand } from './lib/types';

declare const __BRAND__: Brand;

/** Brand config baked in at build time from brands/<id>/brand.json. */
export const BRAND: Brand = __BRAND__;

export function contentUrl(path: string): string {
  return `${BRAND.contentOrigin}/${path.replace(/^\//, '')}`;
}

/**
 * Brand content nouns — the single source of truth for what a content unit is
 * called in the UI. Gunner publishes standalone STORIES (never "book" or
 * "chapter" on screen); Holdfast publishes BOOKS made of CHAPTERS.
 * Every user-visible string must use these instead of hardcoding nouns.
 */
export interface ContentNouns {
  /** One content unit: 'story' (gunner) or 'chapter' (holdfast). */
  unit: string;
  unitPlural: string;
  Unit: string;
  UnitPlural: string;
  /** The collection a unit belongs to: 'book' for holdfast, null for gunner (flat stories). */
  collection: string | null;
  Collection: string | null;
}

export const NOUNS: ContentNouns =
  BRAND.id === 'gunner'
    ? { unit: 'story', unitPlural: 'stories', Unit: 'Story', UnitPlural: 'Stories', collection: null, Collection: null }
    : { unit: 'chapter', unitPlural: 'chapters', Unit: 'Chapter', UnitPlural: 'Chapters', collection: 'book', Collection: 'Book' };

/** "3 chapters" / "1 story" — count with the right brand noun. */
export function countUnits(n: number): string {
  return `${n} ${n === 1 ? NOUNS.unit : NOUNS.unitPlural}`;
}
