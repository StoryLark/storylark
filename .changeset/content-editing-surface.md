---
'storylark-pipeline': minor
'storylark-worker': minor
'storylark-core': minor
---

The deployment stores its own source, so content can be edited from the portal (AB#7420, AB#7421)

Publishing was one-way: markdown in, artifacts out, with the source never
leaving the machine that ran it. That — not a missing textarea — is why nothing
could be edited anywhere but there. `publish.mjs` now uploads the source
markdown and book metadata alongside the derived artifacts
(`books/<id>/source/…`), which makes the deployment self-describing and makes
everything below possible.

**Pipeline** — source upload for every chapter that has any; `--pull` to fetch
deployment-side edits back into your working tree before publishing; `--no-source`
to opt out; the library version is now seeded from the live manifest so a laptop
that has fallen behind can't write a version that goes backwards; `audioStale`
is derived from whether narration matches the current content hash.

**Worker** — a new admin content API under `/api/admin/content/*` plus
`POST /api/admin/upload`, all admin-session gated: list the library, read and
save a chapter's markdown, live preview through the same parser that publishes,
download the current file, revision history with revert, chapter delete,
book-level metadata, and image upload for covers and inline art. A new
platform-agnostic `ContentStore` seam backs it — R2 on Cloudflare via the
binding already there, Azure Blob or a local directory on the Node entry.

**Correction vs publication** — an edit flagged as a correction delivers the new
text to readers but does not announce it: `manifest.announceVersion` stays put
and no push notification is sent, while `libraryVersion` and the database's
`manifest_version` still move so the fix actually reaches people. A genuine
publication bumps and notifies as before. `POST /api/admin/publish` takes the
same `announce` flag, defaulting to true.

**Core** — the admin portal gains a content manager that respects how the
library is arranged (`layout: flat` shows stories, `series` shows books then
chapters): a plain markdown editor with live preview, download and upload of the
`.md`, an insert-image action that uploads and inserts the reference for you,
five-revision history with one-click revert, and the correction toggle on save.
The reader now caches a downloaded chapter's images alongside its text and
audio, and the new-content badge follows `announceVersion`.

Narration is unchanged and deliberately not part of this: a Worker cannot run
the TTS model, so a portal edit publishes text instantly and marks the chapter
*audio out of date* until the pipeline catches up. The portal says so.
