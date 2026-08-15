# Authoring Stories

StoryLark's default, built-in story format is plain markdown in a folder
convention — no code, no custom parser. `packages/pipeline/publish.mjs` reads
it automatically; `--parser` is only for content in some other shape.

## Layout

```
<source>/books/
  gunner-and-the-comet/
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
  "title": "Gunner and the Comet",
  "author": "Gunner the Lab",
  "description": "A very good dog chases a comet across three chapters.",
  "order": 1,
  "coverSource": "/images/gunner-and-the-comet.jpg"
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

The comet's tail swallowed the last of the sunlight, and Gunner's ears
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
author: Holdfast Press
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

## Markdown block conventions

The same conventions the pipeline has always used — see
[`content-pipeline.md`](content-pipeline.md#markdown-block-conventions-parseblocks)
for the full table (scene breaks, dialogue blocks, images, italics, etc.).

## Publishing

```
node packages/pipeline/publish.mjs --brand <id> --source <path-to-your-source>
```

No `--parser` flag. Add `--no-audio` if you don't have TTS credentials set
up yet, and `--local <dir>` to publish to a local folder instead of the
cloud while you're getting the format right. See
[`content-pipeline.md`](content-pipeline.md) for every flag.

## When you need something other than markdown

If your content genuinely lives somewhere else in a different shape — a CMS,
a database export, HTML files — write a parser and pass `--parser
<module.mjs>`. See the parser contract in
[`content-pipeline.md`](content-pipeline.md#the-parser-contract); the built-in
importer (`packages/pipeline/lib/markdown-import.mjs`) is a complete,
readable example of a parser that satisfies it.
