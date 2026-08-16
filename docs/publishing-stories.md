# Publishing Stories

Two ways to get a story onto a live site: the CLI (full control, including
narration) and the admin portal (browser upload, text-only today).

## Format first

Stories are plain markdown — see [`authoring-stories.md`](authoring-stories.md)
for the full format. No custom parser needed for the common case.

## CLI publish (full pipeline: text + audio + timings)

```
node packages/pipeline/publish.mjs --brand <id> --source <path-to-your-content>
```

This is the complete pipeline: parses your markdown, synthesizes word-synced
narration (28 free on-device voices, or Azure premium voices with your own
key), uploads everything, and updates the manifest. Add `--no-audio` if you
don't have TTS set up yet — the app falls back to on-device Web Speech for
listen mode. Add `--storage azure-blob` if you're deployed on Azure. Full
flag reference: [`content-pipeline.md`](content-pipeline.md).

Re-publishing is cheap: only chapters whose content actually changed are
re-processed (content-hash diffing) — editing one paragraph doesn't
re-narrate the whole book.

## Admin portal upload (browser, text-only)

Open your site's `/admin`, sign in with your operator account (email and
password — see [`admin-guide.md`](admin-guide.md)), and use the "Publish a
story" form: book id, title, author, and the markdown text. This is the
single-chapter shorthand format — one story, no chapters to split.

Under the hood this doesn't reimplement the pipeline in the browser or the
Worker — it commits your markdown to the site's own repo (via the GitHub
API) and triggers `publish.yml`, which runs the exact same
`packages/pipeline/publish.mjs` the CLI uses. There's only ever one publish
pipeline; the portal is just a front door to it.

**Narration depends on what the publish workflow has configured.** If
`AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` are set as repo secrets, the
uploaded story gets full narration. If not, it publishes text-only — the
portal's confirmation message says which happened, honestly, every time.
Requires `GITHUB_REPO` and `GITHUB_DEPLOY_TOKEN` configured on the
deployment (see [`admin-guide.md`](admin-guide.md)); without them, upload
is disabled and the portal tells you why.

## Removing or changing a story

Edit or delete the markdown file and re-run `publish.mjs` (CLI) — there's no
"unpublish" button in the portal yet. See
[`content-pipeline.md`](content-pipeline.md) for how the manifest and
content-hash state track what's live.
