# Build Your Own Presentation

Where a [theme](build-your-own-theme.md) changes how the app *looks* (colors,
fonts, icons), the **presentation layer** is how it's *structured*: how the
library is organized, what content units are called, and how the reader and
player screens are composed. This page covers what's configurable today via
`presentation/<id>/presentation.json` and the direction for the future. Example
presentation templates live in the
[theme & template gallery](https://gallery.storylark.dev/templates.html).

> **This moved out of `brand.json` (2026-08).** `layout` and `nouns` now live in
> their own file, so that updating the StoryLark engine can never touch how your
> library is arranged, and your arrangement can be shared separately from your
> branding. An older single-file `brand.json` still works — the build warns and
> points you at `npx storylark-migrate-brand`, which splits it for you and keeps a
> backup.

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

The tab bar (`packages/core/src/components/TabBar.tsx`) defaults to **Home ·
Library · Now Playing · Settings** along the bottom, and `nav` in your
presentation file changes which entries appear, in what order, what they are
called, and whether the bar runs along the bottom or down the side. The routes
are defined in `packages/core/src/router.ts` (`/`, `/library`,
`/library/<bookId>`, `/read/<bookId>/<chapterId>`, `/now-playing`, `/settings`,
`/about`) and are **not** configurable — v1 rearranges the shell, it does not
invent screens. The operator's [admin portal](admin-guide.md) is deliberately
not one of these: `/admin` is a separate page with its own bundle
([how it's built](design/standalone-admin.md)), so nothing you change about the
reader's presentation touches it, and none of its code ships to readers.

## What you configure via `presentation.json`

The file sits beside your brand folder and is selected by the same build mode:

```
brands/<your-id>/brand.json               identity + look
presentation/<your-id>/presentation.json  shape — this file
deployment/<your-id>/deployment.json      addresses, keys, narration settings
```

```json
{
  "contractVersion": 1,
  "layout": "flat",
  "nouns": { "unit": "story", "unitPlural": "stories",
             "Unit": "Story", "UnitPlural": "Stories",
             "collection": null, "Collection": null }
}
```

### `contractVersion` — why your file keeps working

The leading `"contractVersion": 1` says which version of the format you wrote
against. It exists so that a StoryLark update can't break what you wrote:

- **A field you leave out gets StoryLark's default, forever.** Everything below
  is optional; omit `layout` and you get `flat`, omit `nouns` and you get
  story/stories. A file written today keeps working in every future version.
- **A field StoryLark doesn't recognise is ignored with a warning.** A template
  written for a newer version loads on an older one instead of breaking it.

So the number does *not* change when new options are added — only if the format
is ever reshaped in a way that genuinely breaks old files, which is the one case
the build refuses to guess about.

If the file is missing entirely, the defaults apply and the app still builds.

> **This file is read at request time, not baked in (2026-08).** It ships as
> `dist/presentation.json` and the platform serving your site reads it on the way
> out of every request. Replacing that one file on a deployed site rearranges the
> live site — no rebuild, no redeploy, and on Node not even a restart. See
> [the design note](design/presentation-contract.md).

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

`layout` also sets the DEFAULT for four other keys, because those four used to be
read off it directly: `library.groupBy`, `library.groupOptions`,
`library.showSearch` and `download.mode`. A flat library opens ungrouped with a
search box and a sort picker and auto-downloads only new units; a series library
opens grouped by collection with no controls and keeps everything downloaded.
State any of those four yourself and your value wins.

### `nouns` — what a "unit" and "collection" are called

Every user-visible content word is pulled from `nouns` — the app
never hardcodes "story", "chapter", or "book". Consumed via
`packages/core/src/presentation.ts` (`NOUNS`, `countUnits()`, `fillCopy()`).

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

## The rest of the contract

Beyond `layout` and `nouns`, these keys are read by the screens. Every one of
them is optional and every default below is what the app did before the key
existed, so adding this file changes nothing until you change a value.

| Key | Default | What it does |
|---|---|---|
| `nav.position` | `"bottom"` | `bottom` bar or `side` rail |
| `nav.items` | `["home","library","nowPlaying","settings"]` | which entries, in what order. `about` is also available |
| `nav.labels` | `{}` | per-item label override, e.g. `{ "library": "Shelf" }` |
| `home.sections` | `["continue","newReleases"]` | which sections, in what order. `allUnits` adds a full cover shelf |
| `library.defaultSort` | `"order"` | Site default: `order` · `title` · `author` · `recent` · `timeframe`. On an ungrouped shelf with multiple offered sorts, a reader can save a personal default in Settings. |
| `library.sortOptions` | `["order","timeframe","recent"]` | what the picker offers. `[]` removes it |
| `library.groupBy` | flat `"none"` / series `"collection"` | `none` · `collection` · `group` · `timeframe` |
| `library.groupOptions` | flat `["group"]` / series `[]` | groupings offered alongside the sorts |
| `library.view` | `"list"` | `list` of rows, or a `grid` cover shelf |
| `library.showSearch` | flat `true` / series `false` | the search box |
| `reader.defaultMode` | `"read"` | `read` · `listen` · `readListen`. A reader who has already chosen keeps their choice |
| `player.skipSeconds` | `15` | the transport's skip distance |
| `player.showSpeed` | `true` | the playback-speed dial |
| `cover.aspect` | `"portrait"` | `portrait` (3:4) or `square` cover art on the shelves |
| `detail.*` | all `true` | which of cover / author / description / chapter list / length appear on a detail screen |
| `auth.required` | `false` | `true` puts an account gate in front of the whole app |
| `readerTheme.options` | all five | which bundled sample looks readers may pick in Settings: `storylark` · `loveletter` · `nebula` · `weatherglass` · `wireless`. `[]` removes the picker |
| `readerTheme.forced` | `null` | fix one look for everyone. Overrides a reader's saved choice, not just the control |
| `settings.*` | all `true` | which controls the Settings screen offers: `typography`, `theme`, `narrator`, `autoPlay`, `readAlong`, `keepAwake`, `downloads`, `notifications` |
| `download.mode` | flat `"newUnits"` / series `"everything"` | what the auto-download toggle means |
| `emptyState.*` | see below | first-run and empty-shelf copy |
| `about.links` | `[]` | extra `{ label, href }` links on the About screen |
| `features.<name>` | `{}` | where each new engine feature appears |

### Personal library order

`library.defaultSort` remains the publisher's baseline. When `library.groupBy`
is `"none"` and `library.sortOptions` offers at least two choices, Settings also
shows **Default library order**. A reader can follow **Site default** or save one
of the offered sorts; signed-in readers carry that preference across devices.
Changing the Library picker's current value is temporary, while changing the
Settings value controls how the shelf opens on future visits.

This setting sorts only the top-level entries on the shelf: whole standalone
stories or whole books. It never rearranges chapters inside a book. Chapter
order remains the order published in that book's manifest. A grouped or
series-style library does not show the personal-order setting because its
publisher-defined grouping remains authoritative.

### Reader themes

`readerTheme` is the one key whose default is not "what the app did before it
existed": out of the box the Settings screen offers all five gallery looks. What
that turns on is an **offer**, not a change — the picker's first entry is your
own `theme.css`, selected, so nothing about your library moves until a reader
moves it, and a reader's choice is theirs alone. A look is colours and font
stacks only; it never touches your app name, your icons, your PWA manifest or
the theme package you have installed.

```json
"readerTheme": {
  "options": ["nebula", "wireless"],
  "forced": null
}
```

`"options": []` removes the picker. `"forced": "nebula"` fixes one look for
everyone — Settings shows it as a fixed line, and a reader who had already
chosen something else is moved onto it rather than merely losing the control.
Light and dark stay the reader's either way. `"settings": {"theme": false}`
still removes the whole Theme control, both rows, as it always did.

An operator can set both from the admin portal's **Brand & themes** card
without editing this file.

### Empty-state copy

`{unit}`, `{unitPlural}`, `{Unit}`, `{UnitPlural}`, `{collection}`,
`{Collection}` and — in `librarySearch` only — `{query}` are substituted from
your `nouns`:

```json
"emptyState": {
  "library":       "No {unitPlural} published yet. Check back soon.",
  "librarySearch": "No {unitPlural} match “{query}”.",
  "home":          "Loading the library…",
  "nowPlaying":    "Nothing playing yet."
}
```

### Four worked examples

`presentation/weatherglass`, `presentation/nebula`, `presentation/loveletter`
and `presentation/wireless` are complete files using the keys above, and they
disagree with each other on purpose — the fastest way to see what a key does is
to see two libraries make opposite choices about it:

| | weatherglass | nebula | loveletter | wireless |
|---|---|---|---|---|
| `layout` | `flat` | `series` | `flat` | `series` |
| `nouns.unit` | entry | log (in a *mission*) | letter | episode (in a *serial*) |
| `nav.position` | bottom | **side** | bottom | bottom |
| `nav.items` | 4, default order | 5, incl. `about` | 4, default order | 5, **`nowPlaying` second** |
| `home.sections` | continue, newReleases, **allUnits** | **newReleases first**, continue | continue, newReleases | continue, **allUnits** (no carousel) |
| `library.defaultSort` | `timeframe` | `order` | `recent` | `order` |
| `library.view` | list | **grid** | **grid** | list |
| `reader.defaultMode` | `read` | **`readListen`** | `read` | **`listen`** |
| `player` | core default | skip 30s | skip 10s | skip 30s, **no speed dial** |
| `cover.aspect` | square | square | **portrait** | square |
| `detail` | no author | no cover | no chapter list | core defaults |

Note the last column of the last row. Wireless states no `detail` block at all,
which is not an omission — it is the "a missing key takes the core default"
rule being used deliberately, and it is why that theme will pick up any
improvement core makes to the detail screen without being edited.

The matching brand folders are described in
[`build-your-own-theme.md`](build-your-own-theme.md#sample-themes-to-start-from),
and each has a small sample library under `examples/<id>/`.

### What v1 deliberately does not do

No custom components, no arbitrary screen composition, no new routes. Those are
the level at which a core update *can* break what you wrote, so they are not part
of the supported contract. Cloning the repo and editing the components is always
possible — it is Apache-2.0 — but that path carries no compatibility promise; the
keys above do.

The planned distribution model mirrors themes: official and community
presentation templates published as `storylark-template-*`, importable rather
than copied by hand. Browse existing arrangements in the
[gallery](https://gallery.storylark.dev/templates.html), and see the
[submission guide](https://github.com/StoryLark/gallery/blob/main/CONTRIBUTING.md)
to share your own.
