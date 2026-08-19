import type { LibrarySort, Presentation } from './types';

type LibraryPresentation = Presentation['library'];

/**
 * Personal shelf ordering (AB#7731) is meaningful only when the library opens as one
 * ungrouped shelf and offers a real choice of sorts. Grouped libraries keep
 * their publisher-defined structure; this preference never flattens them.
 */
export function personalLibrarySortOptions(library: LibraryPresentation): LibrarySort[] {
  return library.groupBy === 'none' && library.sortOptions.length > 1 ? library.sortOptions : [];
}

/** A saved choice wins only while this deployment still offers it. */
export function resolvePersonalLibrarySort(library: LibraryPresentation, saved: LibrarySort | ''): LibrarySort {
  return personalLibrarySortOptions(library).includes(saved as LibrarySort) ? (saved as LibrarySort) : library.defaultSort;
}

/** Reader-facing label shared by the Library picker and Settings. */
export function librarySortLabel(sort: LibrarySort, unitLabel: string): string {
  switch (sort) {
    case 'order':
      return `${unitLabel} order`;
    case 'title':
      return 'Title (A–Z)';
    case 'author':
      return 'Author (A–Z)';
    case 'recent':
      return 'Recently released';
    case 'timeframe':
      return 'Chronological';
  }
}
