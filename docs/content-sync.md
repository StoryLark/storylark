# Content Sync — pulling from your own source of truth

Some publishers arrive with nothing but stories. Some arrive with a website
repository full of markdown. Some arrive with a whole content system of their
own. StoryLark supports all three, and the difference between them is one field
on the content: **where it came from**.

The rule everything here follows:

> **Whoever owns the content owns the edit button.**

Content written in the admin portal is edited in the admin portal. Content
synced from somewhere else is **read-only here** and edited at its source. That
single rule is what stops a deployment and a publisher's real catalogue quietly
turning into two different libraries.

## Three starting points

| You have | Source of truth | How content arrives | Editable in the portal |
|---|---|---|---|
| Stories, no website, no repo | **The portal** | Type, paste or upload | Yes |
| A repository of markdown | **Your repo** | StoryLark syncs from it | No — edit in the repo |
| Your own CMS or system | **Your system** | StoryLark reads your feed | No — edit in your system |

You can mix them. A deployment can carry a synced catalogue *and* a few
portal-written stories side by side; each behaves correctly on its own terms,
because ownership is recorded per book and per chapter rather than as a
deployment-wide mode.

## The `origin` field

Every book and chapter in `manifest.json` carries an `origin`:

| Value | Meaning | Editable in the portal |
|---|---|---|
| `portal` | Written in the admin portal | Yes |
| `cli` | Published by `packages/pipeline/publish.mjs` from your markdown | Yes |
| `sync` | Pulled from an external source of truth | **No** |
| `personal` | A reader's own device-local import (PDF/EPUB) | n/a — never on a deployment |

**Absent means `cli`.** Every manifest written before this field existed came
from the pipeline, so an older library keeps working exactly as it did and stays
fully editable. Nothing becomes read-only by omission.

`personal` is a seam, not a feature: device-local imports aren't built yet, and
when they are, they arrive through this discriminator instead of needing a
schema change.

## Repo mode inside the deployment — the Connections section

Since the content-management rework (wave 2), a deployment can sync a git
repository **itself**, with no pipeline run and no operator machine involved.
The portal's **Connections** section is the whole setup: provider (GitHub at
launch — other providers are additive drivers), repository URL, visibility,
branch, path, a read-only token, and a pull interval.

What to know before connecting:

- **Strict contract, one gate.** Only files carrying a `storylark:` block are
  ingested (see [authoring-stories.md](authoring-stories.md)) — opt-in, never
  inferred. Every file goes through the same validator the portal and the
  content API use, so a malformed file is rejected with the same code and
  message whichever door it would have come through. The connection form
  **dry-runs the whole repository first**: a repo that does not validate cannot
  be connected, and every failure names its file and line.
- **HTTPS only, token in the platform secret store.** A deployment has no ssh
  client, so SSH is not offered; a read-only token
  (`CONTENT_SYNC_TOKEN` as a platform secret, or entered in the form) is the
  credential. It is never written to `deployment.json` — a credential in that
  committed file is a hard error, unchanged.
- **The configured path is applied before file bodies are downloaded.** The
  GitHub driver lists only that subtree, batch-reads its Markdown through the
  GraphQL API when a token is available, and fetches referenced covers or
  chapter images only when the validator needs them. A publisher repository
  can therefore contain hundreds of megabytes of unrelated art without being
  loaded into Worker memory. Paths in reports stay repository-relative, and a
  relative asset may live outside the Markdown subtree as long as it remains
  inside the repository. GitHub requires authentication for GraphQL even when
  the repository is public, so anonymous public syncs use individual REST
  reads; give a large public library a read-only token to enable batching.
- **Three trigger tiers.** A **webhook** (signature-verified; unsigned or
  forged deliveries are rejected) makes a push appear within seconds; the
  **daily scheduled pull** on the deployment's existing cron is the safety
  net; **Sync now** in the portal is for right now. Concurrent runs collapse
  into one.
- **A missing file is flagged, never auto-deleted.** A chapter in the library
  but absent from a sync is reported `missing` in the sync report; nothing is
  unpublished until the operator clicks **Remove these N chapters**, which runs
  the ordinary recoverable delete.
- **Existing content is never silently claimed.** The first writer still owns
  each book id. When moving an already-published library to repo mode, enable
  **Adopt matching live books** explicitly. StoryLark then compares the complete
  chapter set, rendered content hashes, declared order, visible book metadata,
  and cover identity. A changed word or missing chapter blocks the connection
  and writes nothing. A match changes only ownership metadata: content objects,
  narration, timings, and every voice variant remain attached. Run **Sync now**
  twice after connecting; the second report must show zero writes.
- **Text syncs instantly; audio does not.** No deployment can run the TTS
  model. A sync enqueues narration for everything it wrote; the narration
  worker you already run (`node packages/pipeline/narrate.mjs`) drains it.

Cloudflare Workers Free permits 50 external subrequests per invocation. The
batched Markdown path leaves that budget for cover and image verification, but
a catalogue declaring roughly 50 distinct repository-hosted assets in one run
can still reach the platform ceiling. Split that catalogue into smaller source
sets or use Workers Paid; StoryLark reports the provider failure and writes no
partial library. Root-relative story artwork (`/images/...`) is resolved with
the same marketing-site origin rule as the publish pipeline, so switching
transports does not create a false content change.

The `contentSource` block in `deployment.json` mirrors the same fields for the
pipeline-side CLI sync below, and supersedes the older `sync` block (which
keeps working):

```json
{
  "contentSource": {
    "mode": "repo",
    "repo": { "provider": "github", "url": "https://github.com/mypress/site",
              "branch": "main", "path": "content", "intervalHours": 24 }
  }
}
```

## Exactly two connectors

StoryLark ships **two** pull connectors and will not grow a third:

- **`git`** — a repository of markdown in StoryLark's own
  [folder-per-book layout](authoring-stories.md).
- **`feed`** — your own system, over the small JSON contract documented below.

A system that fits neither shape uses the **[content API](content-api.md)**
directly — your release process calls StoryLark instead of StoryLark reading you,
against a versioned contract you can pin. Content that arrives that way is
read-only in the portal on exactly the same terms as content that arrives here.
This line is deliberate: *"we'll write a connector for your CMS"* is
an unbounded commitment, and it is the only part of this design that could never
be finished. `sync.mjs` rejects an unknown `kind` rather than quietly ignoring it.

## Running a sync

```bash
node packages/pipeline/sync.mjs --brand <id> [flags] [-- <publish flags>]
```

A sync is an **ordinary publish whose source arrived over the network**. It
resolves your source, materialises it into a staging directory in the blessed
markdown layout, and then runs `publish.mjs` over that directory — so change
detection by content hash, narration, force-alignment, upload, manifest-written-
last and push notification are all the pipeline you already have. There is no
second publish path, no second narration path and no second manifest writer.

Anything after `--` goes straight to `publish.mjs`:

```bash
# a first run, text only, into a local directory
node packages/pipeline/sync.mjs --brand mypress -- --local ./content --no-audio

# the real thing
node packages/pipeline/sync.mjs --brand mypress
```

| Flag | Meaning |
|---|---|
| `--brand <id>` | Required. The same brand id `publish.mjs` takes. |
| `--kind git\|feed` | Which connector. |
| `--url <url>` | Repository URL (git) or feed URL (feed). |
| `--ref <ref>` | git only — branch or tag. Defaults to the repo's default branch. |
| `--path <subdir>` | git only — the subdirectory containing `books/`. |
| `--dry-run` | Fetch and stage, report what was found, publish nothing. |

### Configuration

Flags override environment variables, which override
`deployment/<brand>/deployment.json`:

```json
{
  "contractVersion": 1,
  "appOrigin": "https://app.mypress.example",
  "contentOrigin": "https://content.mypress.example",
  "sync": {
    "kind": "git",
    "url": "https://github.com/mypress/website.git",
    "ref": "main",
    "path": "site"
  }
}
```

| Environment variable | Meaning |
|---|---|
| `STORYLARK_SYNC_KIND` | `git` or `feed` |
| `STORYLARK_SYNC_URL` | Repository or feed URL |
| `STORYLARK_SYNC_REF` | git only — branch or tag |
| `STORYLARK_SYNC_PATH` | git only — subdirectory holding `books/` |
| `STORYLARK_SYNC_TOKEN` | Read-only credential. **Environment only.** |

`deployment.json` is committed, so a credential must never be in it — a `token`
(or `password`, `secret`, `accessToken`) key there is a hard error, not a
warning. A URL with `user:password@` in it is refused for the same reason: it
would end up in logs, in error messages and in the public manifest.

### Scheduling

Run it wherever your publishes already run. Narration needs the TTS model, and a
deployment can't run that — a Worker has no way to synthesise speech — so an
in-deployment scheduled sync could only ever produce silent, permanently
audio-stale content for a whole catalogue. Scheduling therefore lives with the
pipeline:

- **GitHub Actions** — every site scaffolded by `npm create storylark` gets
  `.github/workflows/sync.yml` (from
  [`create-storylark/template/.github/workflows/sync.yml.tmpl`](../create-storylark/template/.github/workflows/sync.yml.tmpl)):
  a nightly cron plus a manual-run button, alongside the `publish.yml` it
  already ships. Set the `SYNC_KIND`/`SYNC_URL` repository variables to turn it
  on; with none set it stops and says so rather than doing anything surprising.
  Delete the file if your content lives in the site itself.
- **Anything else** — cron, systemd timer, Task Scheduler, your own CI. It's one
  command and it exits non-zero on failure.

A sync run with nothing new to pull publishes nothing: change detection is by
content hash, exactly as an ordinary publish.

## Connector 1 — a git repository of markdown

Your repository holds markdown in the [layout StoryLark already
documents](authoring-stories.md):

```
<repo>/<path>/books/
  the-comet-chase/
    book.json
    01-liftoff.md
    02-the-long-dark.md
  a-quiet-evening.md
```

The connector runs a real `git clone --depth 1` — not a call to some host's file
API — so it works against GitHub, GitLab, Bitbucket, Gitea, Azure DevOps, a bare
repo on a server, or a path on disk, with no per-host code. The clone is thrown
away and remade each run rather than pulled: a stale working tree after a
force-push is a silent wrong-content bug, and a fresh shallow clone can't have
one.

Private repositories authenticate with `STORYLARK_SYNC_TOKEN`, injected as
`x-access-token` in the clone URL and redacted from every line the command
prints. A publisher keeping their site source private is entirely normal, so
this works from the start.

```bash
STORYLARK_SYNC_TOKEN=ghp_… \
  node packages/pipeline/sync.mjs --brand mypress \
    --kind git --url https://github.com/mypress/website.git --ref main --path site
```

## Connector 2 — your own system, over a JSON feed

If you have a CMS, a database or anything else that can serve JSON, expose one
endpoint in the shape below and StoryLark reads it. The contract is deliberately
the smallest thing that can describe a library, and it is written against
nobody's particular product.

### The feed

```json
{
  "storylarkFeedVersion": 1,
  "generatedAt": "2026-08-16T12:00:00Z",
  "books": [
    {
      "id": "the-keepers",
      "title": "The Keepers",
      "author": "Holdfast Press",
      "description": "Published chapters from the lighthouse.",
      "order": 1,
      "coverUrl": "https://press.example.com/covers/the-keepers.jpg",
      "chapters": [
        {
          "id": "the-lamp-room",
          "title": "The Lamp Room",
          "label": "Chapter 1",
          "markdownUrl": "/exports/keepers-01.md"
        },
        {
          "id": "the-second-watch",
          "title": "The Second Watch",
          "label": "Chapter 2",
          "markdown": "The second watch belonged to the sea…"
        }
      ]
    }
  ]
}
```

**Top level**

| Field | Required | Meaning |
|---|---|---|
| `storylarkFeedVersion` | no | `1`. A different value is read as 1 with a warning. |
| `generatedAt` | no | Informational. |
| `books` | **yes** | The whole library. An empty array is an error, not a no-op — it almost always means a broken export, and treating it as "delete everything" would be the wrong guess. |

**Book**

| Field | Required | Meaning |
|---|---|---|
| `id` | **yes** | 1–64 lowercase letters, digits or hyphens. Becomes the book's address and its folder in storage, so keep it stable. |
| `title` | no | Book title. |
| `author` | no | Shown in the library and on the book screen. |
| `description` | no | Shown on the book screen. |
| `order` | no | Sort position (lower first). |
| `coverUrl` | no | Absolute or relative to the feed URL. Downloaded and published as the book's cover. |
| `chapters` | **yes** | At least one. **Array order is reading order.** |

**Chapter**

| Field | Required | Meaning |
|---|---|---|
| `id` | **yes** | 1–64 lowercase letters, digits or hyphens. Stable — it's in reader URLs and in saved progress. |
| `title` | no | Chapter title. |
| `label` | no | Short label in the reader, e.g. `Chapter 2`. Defaults to `Chapter`. |
| `markdown` | one of | The chapter text, inline. |
| `markdownUrl` | one of | Absolute, or relative to the feed URL. Fetched as UTF-8 markdown. |

Exactly one of `markdown` / `markdownUrl` is needed. Both are supported because a
system with the text to hand shouldn't be forced into a second request per
chapter, and one that stores files shouldn't have to inline megabytes.

The markdown itself is
[StoryLark's own markdown](authoring-stories.md#markdown-block-conventions) — plain
paragraphs, `* * *` scene breaks, `*emphasis*`, images. If a chapter's markdown
already has front matter, **it wins**: your `title`/`label` are only used to fill
in what you didn't state there.

### Authentication

`STORYLARK_SYNC_TOKEN` is sent as `Authorization: Bearer <token>` to the feed
**and to any URL on the same origin as the feed** — never to another origin. A
feed pointing at a CDN or a third-party image host must not be able to make the
sync hand that host your credential.

```bash
STORYLARK_SYNC_TOKEN=… \
  node packages/pipeline/sync.mjs --brand mypress \
    --kind feed --url https://press.example.com/storylark/feed.json
```

## What "read-only in the portal" actually means

The admin portal **shows** synced content — you need to see your whole library in
one place — and lets you read it, preview it, download the markdown and browse
its revision history. What it does not do is let you change it:

- Synced books and chapters are labelled **synced** in the listing.
- Opening one gives a read-only view with a **Managed externally** notice naming
  the source and linking to it, instead of an editor.
- Save, upload-`.md`, insert-image, revert, delete and book-metadata controls are
  not offered at all — an operator shouldn't discover a refusal after typing a
  paragraph.

The API enforces the same rule independently of the UI. Every write route
answers **`409 managed_externally`** with a message naming the actual source:

```json
{
  "error": "managed_externally",
  "message": "\"the-keepers/the-lamp-room\" is managed externally — edit it at source. \"the-keepers\" is synced into this deployment from the git repository https://github.com/mypress/website.git (branch main), so it is a copy, not the original: a change saved here would be overwritten the next time the sync runs. Change it there, then re-sync. (See docs/content-sync.md.)",
  "origin": "sync",
  "syncSource": { "kind": "git", "url": "…", "ref": "main", "syncedAt": "…" }
}
```

409 rather than 403: nothing is wrong with your credentials — the request
conflicts with where the content lives.

## Onboarding a large catalogue

Ingestion is the easy half. **Narration is the expensive half**: a thousand
stories is a thousand TTS runs, and the first sync of a large catalogue is a long
job. Run it with `--no-audio` first if you want the text live immediately, then
run it again without that flag to narrate — change detection means the second run
re-uses everything the first one published, and each chapter's narration lands as
it finishes.

A bulk narration queue with progress and time estimates is planned separately.
It is the genuinely expensive piece of serving a large publisher, and it is
needed the first time *anyone* publishes fifty stories at once.

## See also

- [Authoring Stories](authoring-stories.md) — the markdown format a synced repo uses.
- [Publishing Stories](publishing-stories.md) — the operator's guide to the CLI and the portal.
- [Content Pipeline](content-pipeline.md) — what `publish.mjs` does with what sync hands it.
- [API Reference](api.md) — the content endpoints a push integration calls.
