# Design: Content Flow

How a story goes from a markdown file to something a reader can open and
listen to.

**Diagram:** [`content-flow.drawio`](content-flow.drawio) — open in
[app.diagrams.net](https://app.diagrams.net) or the draw.io desktop app. *No
PNG export is committed yet* — open the file once and export a PNG
alongside it per the documentation standard.

## The pipeline

`packages/pipeline/publish.mjs` is the single entry point, whether it's
invoked from the CLI or dispatched by the admin portal's story-upload form
(via `publish.yml` — see [`update-flow.md`](update-flow.md) for the sibling
self-update mechanism, which uses the same dispatch pattern).

1. **Parse** — `lib/markdown-import.mjs` (the default) or a custom
   `--parser` turns your source into the canonical
   `{ books: [{ book, chapters }] }` shape.
2. **Diff by content hash** — only chapters whose hash actually changed
   proceed past this point. Re-publishing an unchanged book is nearly free.
3. **Narrate** — Kokoro (on-device, free) or Azure Speech (cloud, your key)
   synthesizes each chapter per configured voice.
4. **Force-align** — word-level timings are computed against the *actual*
   synthesized audio, not estimated from text length — this is what makes
   read-along highlighting land on the right word.
5. **Upload** — chapter JSON, audio, and timings go to storage
   (`packages/pipeline/storage.mjs` — R2 or Azure Blob) under
   content-hashed, immutable keys.
6. **Manifest, last** — the library manifest is uploaded only after every
   chapter it references is already live, so a reader can never load a
   manifest pointing at a missing file.
7. **Notify** — `POST /api/admin/publish` fires web push to subscribed
   readers.

`--no-audio` skips straight from the diff step to upload — a text-only
publish, with listen mode falling back to on-device Web Speech.

## Where the admin portal fits in

The portal's "Publish a story" form (`/admin`, see
[`admin-guide.md`](../admin-guide.md)) does not run any of this itself. It
commits markdown to the site's own repo via the GitHub API and dispatches
`publish.yml`, which runs the exact pipeline above. This keeps there from
ever being two implementations of "how a story gets published" that could
drift apart.
