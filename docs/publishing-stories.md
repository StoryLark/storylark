# Publishing Stories & Books

StoryLark supports standalone stories, multi-chapter books, and a library that
contains both. The supported setup starts with one of three content entry
points: **Portal**, **Repository**, or **CMS / API**. The CLI and generated
GitHub workflows remain useful publishing tools, but they are not extra
connection types.

## Format first

The common source format is plain Markdown. A single `.md` file is a standalone
story; a folder with book metadata and ordered chapter files is a book. See
[`authoring-stories.md`](authoring-stories.md) and the normative
[`content-format.md`](content-format.md).

## Choose who owns the source

Pick one owner for each book or story:

| Path | Source of truth | Narration | What Connections shows |
|---|---|---|---|
| Portal / Upload Markdown | The deployment | Queued after text is saved | Portal mode |
| Repository (wizard or Admin) | The connected repository | Changed text is queued for the narration worker | Saved repository details and sync status |
| CMS / API | Your external system | Whatever that system publishes or queues | API mode and tokens |
| Publish with narration (GitHub) | The publisher site's repository | The GitHub workflow runs the pipeline | Publishing tool; not a saved repo connection |
| CLI publish | Your local source tree | The CLI can generate text, audio, and timings | Publishing tool; not a saved repo connection |

The last column is important. **Repository mode is saved by StoryLark's setup
wizard or Connect a repo flow.** If Repository was selected during setup and
Connections is blank, installation did not finish correctly. A deliberately
configured advanced workflow can still clone a repository and publish through
`/api/content/v1`, but that is a publishing tool rather than a saved connection.

## Admin: Upload Markdown

Open `/admin`, choose **Stories & Books**, then **Upload markdown**. You can
create a standalone story or add content to a book without a local checkout.
Text publishes immediately. If narration is configured, the changed chapter is
added to the Narration queue; until it completes, existing audio can be marked
out of date and text-only content uses the device speech fallback.

Once published, deployment-owned content can be edited with live preview,
downloaded as Markdown, reordered, reverted through five-version history, and
deleted with typed confirmation. Content marked **managed externally** is
read-only: change or remove it in its source system, then publish or sync again.

## Admin: Connect a repo

Choose **Repository** in the setup wizard, or **Connect a repo** later, when you
want StoryLark itself to store and operate a read-only repository connection.
The flow validates the repository before it writes anything and, once saved,
Connections shows the URL, branch, path, credential presence, last/next sync,
**Sync now**, webhook state, and per-file results.

Public repositories need no credential. Private repositories need a durable,
read-only token scoped to that repository. Never commit it. A GitHub App
installation token that expires in about an hour is useful for an automation
run, but it is not a durable credential for scheduled sync.

For an existing live library, use **Adopt matching live books** only after a
backup. Adoption is atomic and matching-only: chapter set, rendered content,
order, visible metadata, and cover identity must all match. StoryLark changes
ownership metadata without replacing content objects, narration, timings, or
voice variants. Run **Sync now** twice and require the second run to report zero
writes before considering the change complete. See
[`deployment-safety.md`](deployment-safety.md).

## Publish with narration through GitHub

The GitHub-backed publisher is a different door. It commits source Markdown to
the publisher site's repository and dispatches `publish.yml`, which runs the
same pipeline used by the CLI. It is useful when you want a browser front door
to a repository-owned narration workflow.

It requires `GITHUB_REPO` plus a durable repository-scoped
`GITHUB_DEPLOY_TOKEN` with the exact permissions documented in
[`admin-guide.md`](admin-guide.md). Those settings enable this publishing
workflow; they do **not** create an Admin repo connection.

The generated `publish.yml` is deliberately text-only unless
`AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` are present; with those secrets it
publishes Azure narration. To use the free bundled narrator, publish from a
machine or runner that has the local model dependencies and `ffmpeg`, and do not
pass `--no-audio`. The portal must report honestly when a publish is text-only.

## CLI publish

For full local control, including narration and word timings:

In a site created with `npm create storylark`, the brand and default `content/`
source are already in the package script:

```text
npm run publish
```

For a different source directory, or in custom automation, invoke the installed
binary explicitly:

```text
npx storylark-publish --brand <id> --source <path-to-content>
```

Engine contributors running the monorepo can use
`node packages/pipeline/publish.mjs` instead.

The bundled local narrator is the free default. Add `--no-audio` for a
text-only publish, or select the Azure storage/provider options documented in
[`content-pipeline.md`](content-pipeline.md).

Re-publishing is incremental: unchanged chapters are not rewritten, and a text
edit re-narrates only changed blocks. Before publishing from a working tree that
may have diverged from Admin, use `--pull`. A true conflict is refused instead
of silently overwriting live text; `--force` is the explicit override.

## Publish from your own system

If you already have a CMS, release job, or GitHub Actions workflow, call
`/api/content/v1` directly. The versioned contract supports a chapter, a whole
book, and zip/batch catalogue imports. Content appears as externally managed so
Admin cannot accidentally edit a copy your source system will overwrite later.
See the [engine content API reference](https://github.com/StoryLark/storylark/blob/main/docs/content-api.md).

This is how an external repository workflow can publish without appearing in
Connections: the workflow owns the repository access; StoryLark receives the
result through the API.

## Removing or changing content

- For deployment-owned content, edit or delete it in **Stories & Books**.
- For a saved Admin repo connection, edit the repository and sync. Missing
  files are reported but never auto-deleted; an operator confirms removal.
- For API/Actions-managed content, change or delete it at the source and use the
  API's delete operation when removal is intended.
- For CLI-owned content, change the Markdown and publish again.

These rules protect against data loss: an absent file, partial archive, failed
fetch, renamed directory, or wrong branch is never treated as permission to
erase a live story.
