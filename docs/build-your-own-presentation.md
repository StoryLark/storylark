# Build Your Own Presentation

Where a [theme](build-your-own-theme.md) changes how the app *looks* (colors,
fonts, icons), the **presentation layer** is how it's *structured*: how the
library is organized, what content units are called, and how the reader and
player screens are composed. This page covers what's configurable today via
`brand.json` and the direction for the future. Example presentation templates
live in the [theme & template gallery](https://gallery.storylark.dev/templates.html).

## What ships today

The app is a fixed-shell PWA (`packages/core/src/`) with these screens and one persistent
tab bar:

```
Home        Continue card (resume where you left off) + new-releases carousel
Library     the shelf — sorting, search, cover art (list vs grouped by layout)
Book        a unit's detail / chapter list
Reader      read / listen / read+listen with word-synced highlighting
Now Playing full-screen audio player
Settings    account, typography, theme, read-along mode, downloads
About       app version, changelog, roadmap
```

The tab bar (`packages/core/src/components/TabBar.tsx`) is fixed: **Home · Library · Now
Playing · Settings**. The routes are defined in `packages/core/src/router.ts`
(`/`, `/library`, `/library/<bookId>`, `/read/<bookId>/<chapterId>`,
`/now-playing`, `/settings`, `/about`). This structure is not currently
config-driven — changing nav arrangement or screen composition means editing the
components.

## What you configure via `brand.json`

Two fields drive presentation without touching code:

### `layout` — flat vs series

```jsonc
"layout": "flat"    // standalone units in one flat list, no collection level
"layout": "series"  // units grouped into collections
```

- **`flat`** — every unit stands alone and shows in a single flat list (think a
  library of standalone short stories). No collection/grouping level. Flat
  manifests may still carry an optional `group` label and an in-world `timeframe`
  (`"YYYY-MM"`) for chronological sorting.
- **`series`** — units are grouped into collections (think books grouped into a
  series). Manifest entries carry `series`, `seriesOrder`, `bookOrder`, etc.

The `layout` value also changes an auto-download default (see the `autoDownload`
setting in `packages/core/src/lib/types.ts`): flat auto-downloads new units; series keeps a
whole collection downloaded.

### `nouns` — what a "unit" and "collection" are called

Every user-visible content word is pulled from `brand.json` `nouns` — the app
never hardcodes "story", "chapter", or "book". Consumed via
`packages/core/src/brand.ts` (`NOUNS`, `countUnits()`).

```json
"nouns": {
  "unit": "story",      "unitPlural": "stories",
  "Unit": "Story",      "UnitPlural": "Stories",
  "collection": null,   "Collection": null
}
```

| Key | Meaning |
|---|---|
| `unit` / `unitPlural` | Lowercase singular/plural of one content unit ("story"/"stories", "chapter"/"chapters"). |
| `Unit` / `UnitPlural` | Capitalized forms for sentence starts / headings. |
| `collection` / `Collection` | The grouping level's name ("book", "series"), or `null` for a flat library. |

Example for a chaptered-book library:

```json
"layout": "series",
"nouns": {
  "unit": "chapter", "unitPlural": "chapters",
  "Unit": "Chapter", "UnitPlural": "Chapters",
  "collection": "book", "Collection": "Book"
}
```

`countUnits(n)` then renders "1 chapter" / "3 chapters" automatically, and
`layout: "series"` groups those chapters under their book.

## Content shape

The manifest and chapter schema the presentation renders is produced by the
publish pipeline. Blocks the reader knows how to render (from
`packages/core/src/lib/types.ts` / `BlockRenderer`):

`paragraph` (with `em`/`strong` spans) · `scene-break` · `display-beat` ·
`message-block` (speaker/time/text) · `image` · `end-marker`.

How markdown maps to these blocks is documented in
[`content-pipeline.md`](content-pipeline.md); how the reader renders and
highlights them is in [`read-along.md`](read-along.md).

## The direction (planned)

The `layout` + `nouns` fields are the first slice of a larger idea: a
**presentation-layer template** that is distinct from a theme — the theme carries
identity (colors/fonts/icons), the presentation template carries structure (nav
arrangement, screen composition, library organization). Today the shell is fixed
and only `layout`/`nouns` vary it.

The planned distribution model mirrors themes:

- Official presentation templates: `@storylark/template-*`.
- Community templates: `storylark-template-*`.

Swappable presentation templates and a config-driven shell are **planned**, not
available today. What you can rely on now is `layout` and `nouns`; deeper changes
require editing the app components. Browse existing arrangements in the
[gallery](https://gallery.storylark.dev/templates.html), and see the
[submission guide](https://github.com/StoryLark/gallery/blob/main/CONTRIBUTING.md)
to share your own.
