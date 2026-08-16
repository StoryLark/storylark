# Design: Admin Publish

How the admin portal's "Publish a story" form turns pasted markdown into a
live, narrated chapter — without becoming a second implementation of
[`content-flow.md`](content-flow.md)'s pipeline.

**Diagram:** [`admin-publish.drawio`](admin-publish.drawio) — open in
[app.diagrams.net](https://app.diagrams.net) or the draw.io desktop app. *No
PNG export is committed yet* — open the file once and export a PNG
alongside it per the documentation standard.

## The constraint that shapes everything here

A Worker has no filesystem, no git, and no build tooling — it cannot run
`publish.mjs` itself. Reimplementing that pipeline's parsing/narration/
force-alignment/upload/manifest logic a second time inside the Worker was
considered and rejected: two implementations of "how a story gets
published" drift apart, silently, the moment either one changes. So the
admin portal's job is deliberately narrow: **get the markdown into the
repo, then trigger the exact same CI path an operator's own `git push`
would trigger.** This is the same shape as [`update-flow.md`](update-flow.md)'s
self-update mechanism — the deployed app can never do real work itself, so
it always hands off to CI, which can.

## The flow

1. **Operator fills the form** (`/admin`, see [`admin-guide.md`](../admin-guide.md)) —
   book id, title, author, description, markdown body. Client-side, this is
   just a plain textarea; no markdown preprocessing happens before it leaves
   the browser.
2. **`POST /api/admin/publish-story`** (`packages/worker/src/routes/admin.ts`),
   gated to authenticated admins only. The Worker does exactly two things,
   both against the site's own GitHub repo via the Contents API:
   - Wraps the markdown in frontmatter (`title`, `author`, `description`,
     `label: Read`) and commits it to `content/books/<bookId>.md` — an
     update if the file's blob `sha` already exists, a create otherwise.
     This is the single-file shorthand from
     [`authoring-stories.md`](../authoring-stories.md), not the full
     folder-per-book layout — the portal trades structure for simplicity on
     this path; multi-chapter books still go through the CLI.
   - Dispatches `publish.yml` via `workflow_dispatch`.
3. **`publish.yml` runs the real pipeline** — parse → diff by content hash →
   narrate → force-align → upload → manifest, last → push-notify, exactly as
   described in `content-flow.md`. Narration only happens if that
   workflow's TTS credentials (e.g. `AZURE_SPEECH_KEY`) are configured in
   the repo's own secrets; the portal has no way to know that in advance.
4. **The response is honest about what it doesn't know.** A 502 from the
   commit step means the story never left the browser's request — nothing
   changed. A 207 means the commit landed but the dispatch failed — the
   markdown is in the repo but nothing will publish it until the operator
   re-runs `publish.yml` by hand. A 200 only ever means "committed and
   dispatched," never "published" or "narrated" — the portal cannot see
   inside the Action run it just started, so it never claims outcomes it
   hasn't observed.

## Why GitHub-committed, not a direct storage write

Committing through the repo (rather than having the Worker write straight
to R2/Blob storage) keeps the repo as the single source of truth for
content the same way it already is for code — `git log` shows who
published what and when, a bad publish is a revert, and the CLI and portal
paths produce byte-identical results because they're the same file ending
up in the same place. The cost is a dependency on `GITHUB_REPO` +
`GITHUB_DEPLOY_TOKEN` being configured (see `admin-guide.md`'s "Turning
features on" table) — without them, the portal still shows status/update
information, but publishing is disabled with an explanation rather than
silently failing.

## Where this stops

Multi-chapter books, cover images, and inline images are explicitly out of
scope for this form — it publishes one chapter's worth of plain markdown
per submission. Anything more structured than that goes through the CLI
(`packages/pipeline/publish.mjs` directly against a `books/<id>/` folder)
until the portal's editing surface grows beyond upload-only, which is
future work, not this design.
