---
'storylark-pipeline': minor
---

Content upload now goes through a storage seam (`storage.mjs`,
`resolveProvider`) instead of importing the Cloudflare R2 uploader
directly. `r2-upload.mjs` stays the default, unchanged driver; a new
`storage-azure.mjs` driver covers Azure Blob Storage. Select with
`--storage r2|azure-blob` on `publish.mjs` or the `STORYLARK_STORAGE` env
var.

`--parser` is now optional. `lib/markdown-import.mjs` is the new default
parser: the blessed StoryLark story format — one folder per book
(`book.json` + numbered chapter `.md` files) or a single `.md` file as
shorthand for a one-chapter book. `--parser` remains available for content
in some other shape. See `docs/authoring-stories.md` for the format spec.
