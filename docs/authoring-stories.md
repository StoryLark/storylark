# Authoring Stories & Books

StoryLark's default, built-in story format is plain markdown in a folder
convention — no code, no custom parser. `packages/pipeline/publish.mjs` reads
it automatically; `--parser` is only for content in some other shape.

## Layout

```
<source>/books/
  the-comet-chase/
    book.json
    01-liftoff.md
    02-the-long-dark.md
    03-splashdown.md
  a-quiet-evening.md        ← shorthand for a single-chapter book
```

## A multi-chapter book

A folder under `books/` is one book. Chapter files are `.md`, ordered by
filename — the leading number is stripped to make the chapter id (so
`02-the-long-dark.md` becomes chapter id `the-long-dark`; override with
`chapterId` in that chapter's frontmatter if you want a different id).

`book.json` holds the book-level metadata:

```json
{
  "title": "The Comet Chase",
  "author": "Example Press",
  "description": "A short adventure across three chapters.",
  "order": 1,
  "coverSource": "/images/the-comet-chase.jpg"
}
```

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | Book title. |
| `author` | no | Shown in the library and book screen. |
| `description` | no | Shown on the book screen. |
| `order` | no | Sort position in the library (lower first). |
| `coverSource` | no | Path under `<source>/public/` to the cover image. Falls back to `brands/<id>/assets/covers/<book-id>.<ext>` if omitted — see [`content-pipeline.md`](content-pipeline.md). |

`book.json` is optional — if you omit it, the first chapter file's
frontmatter is used for the book's title/author/description/order instead
(handy for a book that's really just one long chapter; see below).

Each chapter file may have its own frontmatter for chapter-specific fields:

```markdown
---
title: The Long Dark
label: Chapter 2
---

The comet's tail swallowed the last of the sunlight, and her ears
went flat against his head...
```

| Field | Meaning |
|---|---|
| `title` | Chapter title (defaults to the book title if omitted). |
| `label` | Short label shown in the reader/list (e.g. "Chapter 2"). Defaults to "Chapter". |
| `chapterId` | Override the filename-derived chapter id. Rarely needed. |

## A single-chapter book (shorthand)

For a standalone story with no chapters to split, skip the folder — one
`.md` file directly under `books/` is a whole book with one chapter (id
`full`). Its frontmatter carries the book metadata:

```markdown
---
title: A Quiet Evening
author: Example Press
description: Nothing happens, and it's wonderful.
order: 4
label: Read
---

The porch light hummed...
```

This is what `examples/demo/books/gift-of-the-magi/` and
`the-yellow-wallpaper/` demonstrate (as folders with a single `01-full.md`
chapter) — either shape works; use the folder form once a book actually has
more than one chapter, or if you want `book.json` kept separate from the
first chapter's text.

## The `storylark:` block — declaring content explicitly

Alongside the layout convention above, a file can carry a namespaced
`storylark:` block in its frontmatter. It is **additive**: nothing else in the
file changes, your own fields are untouched, and your own site's build ignores
the extra key.

```markdown
---
title: The Voyage Home, Going East     # your field, untouched
storyNumber: 1                          # your field, untouched
storylark:                              # ← the only thing you add
  type: chapter
  book: the-voyage-home
  chapter: going-east
  order: 1
---
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | `book` \| `chapter` \| `story` | yes | What this file is. |
| `book` | id | for `chapter` | The book this chapter belongs to. |
| `chapter` | id | for `chapter` | This chapter's id. |
| `order` | integer | for `chapter` | Position within the book. Gaps are fine; **ties are an error**, never silently resolved. Where a block declares `order`, filename prefixes are not consulted. |
| `publish` | boolean | no (default `true`) | `false` withholds the chapter: it validates, and it is not published. |
| `title` | string | no | Overrides the top-level `title`. |
| `cover` | path | no | Relative to the file — never a URL; images are ingested, not hotlinked. |
| `contractVersion` | integer | no (default `1`) | Pins the format. |

- `type: story` is a book with exactly one chapter, in one file — `book`,
  `chapter` and `order` are then optional.
- `type: book` carries book metadata only (no prose).
- Ids are lowercase `[a-z0-9-]`, and stable: changing an id creates a new
  object.

**For content synced from a repo the block is required**: a file without a
`storylark:` block is not StoryLark content and is never ingested — drafts and
non-content files are safe by default because ingestion is opt-in, never
inferred. Content published through the portal or the
[content API](content-api.md) doesn't need the block (the request itself states
the identity), but when the block is present it is validated strictly and must
agree with the address it arrived at.

Validation is one gate with one error vocabulary: the same bad file produces
the same error code and message whether it comes through the portal (inline),
a repo sync, or the API (`422`). A repository arrival is atomic: every problem
is listed, and nothing from that arrival is published until all candidates are
valid. A source file that disappears is reported as missing but is never
deleted automatically.

## Markdown block conventions

The same conventions the pipeline has always used — see
[`content-pipeline.md`](content-pipeline.md#markdown-block-conventions-parseblocks)
for the full table (scene breaks, dialogue blocks, images, italics, etc.).

## Publishing

```
npx storylark-publish --brand <id> --source <path-to-your-source>
```

No `--parser` flag. Add `--no-audio` if you don't have TTS credentials set
up yet, and `--local <dir>` to publish to a local folder instead of the
cloud while you're getting the format right. See
[`content-pipeline.md`](content-pipeline.md) for every flag.
## When this layout already lives in a repository

If these files are in a git repository that is *your* source of truth — a
website repo you publish from, say — StoryLark can pull from it on a schedule
instead of you running a publish by hand. Content that arrives that way is
read-only in the admin portal, because the repo owns it. See
[`content-sync.md`](content-sync.md).

## When you need something other than markdown

If your content genuinely lives somewhere else in a different shape — a CMS,
a database export, HTML files — write a parser and pass `--parser
<module.mjs>`. See the parser contract in
[`content-pipeline.md`](content-pipeline.md#the-parser-contract); the built-in
importer (`packages/pipeline/lib/markdown-import.mjs`) is a complete,
readable example of a parser that satisfies it.
