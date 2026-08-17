# Content API — pushing content into a StoryLark deployment

**Audience: an engineer integrating an existing publishing system with StoryLark.**
You should be able to write the integration from this page alone. Nothing here
requires reading StoryLark's source.

There are three ways content gets into a deployment, and this document is the
third:

| You have | Source of truth | How content arrives |
|---|---|---|
| Stories, no website, no repo | The admin portal | Type, paste or upload. Fully editable there. |
| A website repo of markdown | Your repo | StoryLark pulls from it — [`content-sync.md`](content-sync.md). |
| **Your own CMS or system** | **Your system** | **It calls this API when you publish.** |

The rule underneath all three: **whoever owns the content owns the edit button.**
Content you push here is read-only in StoryLark's admin portal by default, so a
StoryLark operator can never edit a copy of something your system will overwrite
on its next push.

StoryLark will never write a connector for a specific CMS. This API is what that
refusal points at — one contract, versioned, that any system can call.

---

## The contract in one minute

```bash
curl -X PUT https://app.example.com/api/content/v1/books/the-keepers \
  -H "X-Admin-Key: $STORYLARK_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contractVersion": 1,
    "title": "The Keepers",
    "author": "H. Press",
    "source": { "url": "https://press.example.com/books/the-keepers", "system": "Acme CMS" },
    "chapters": [
      { "id": "arrival",       "markdown": "---\ntitle: Arrival\n---\n\nThe boat came in at dusk.\n" },
      { "id": "the-long-dark", "markdown": "---\ntitle: The Long Dark\n---\n\nWinter took the harbour.\n" }
    ]
  }'
```

That is the whole integration for most publishers: one hook in your release step
that PUTs each book you just published.

---

## Base URL and versioning

```
https://<your-app-origin>/api/content/v1
```

The major version is **in the path** and **in every request body**
(`contractVersion`). Both are required, and the redundancy is deliberate — the
path is what you route and cache on, the body field is what a payload carries
when it has been queued, logged or replayed away from its URL.

Rules this contract follows, so you can pin against it:

- **New optional fields do not move the version.** A client written for
  `contractVersion: 1` keeps working when fields are added.
- **Unknown fields in your request are ignored, not rejected.** A client written
  against a newer minor contract still succeeds against an older deployment.
- **The version moves only on a breaking reshape.** `GET /api/content/v1` tells
  you the range a given deployment accepts.

A request with no integer `contractVersion` is a `400 contract_version_required`.
That is on purpose: a caller that never states which version it wrote against is
one nobody can safely change anything for.

---

## Authentication

Send the deployment's admin key:

```
X-Admin-Key: <ADMIN_KEY>
```

This is the same credential `packages/pipeline/publish.mjs` uses to notify the
deployment after a publish. It is a deployment secret — a Worker secret on
Cloudflare, an application setting on Azure — not a user password. Rotate it by
changing it in the deployment's configuration; there is nothing else to update.

An admin **session cookie** also works, so an operator can exercise the contract
from a signed-in browser. Cookie-authenticated requests must also send
`X-Requested-With: storylark` (a CSRF guard). Key-authenticated requests do not
need it — a header key is not forgeable by a third-party site.

**Scoped content-API tokens** are the credential to hand a third-party system —
never `ADMIN_KEY`, which also mints admin setup links. An operator creates one
in the portal's **Connections** section (named, individually revocable,
last-used visible); the system sends it as:

```
Authorization: Bearer sct_…
```

A token authenticates this API and nothing else: it cannot reach the admin
surface, trigger updates, or read anything the content API does not serve.
Revocation takes effect on the next request. Only the token's SHA-256 is stored
server-side; the plaintext is shown once at creation.

Anything else is `401 unauthorized`.

---

## Endpoints

| Method & path | What it does |
|---|---|
| `GET /api/content/v1` | The contract, described by the deployment. Versions accepted, limits, defaults, whether it has writable storage. |
| `GET /api/content/v1/catalogue` | Everything the deployment holds, with content hashes — how you push only what changed. |
| `PUT /api/content/v1/books/:bookId` | Create or update one book, optionally with its chapters. |
| `PUT /api/content/v1/books/:bookId/chapters/:chapterId` | Create or update one chapter. |
| `POST /api/content/v1/books` | Many books in one request. The bulk/onboarding door. |
| `POST /api/content/v1/import` | A `.zip` of the markdown-folder layout. The other bulk door. |
| `DELETE /api/content/v1/books/:bookId/chapters/:chapterId` | Remove a chapter from the library. |
| `DELETE /api/content/v1/books/:bookId` | Remove a book from the library. |
| `POST /api/content/v1/sync/webhook` | The repo-sync push trigger. Authenticated by the provider's payload signature, not by a key — see [content-sync.md](content-sync.md). |

Deletes remove the **manifest entry**. The stored objects — the chapter JSON, the
source markdown, the audio, the revision history — stay, because they are
immutable and unreferenced and leaving them makes a mistaken delete recoverable
by pushing the chapter again.

---

## The content shape

A chapter is **markdown with front matter** — the same text StoryLark's CLI reads
off disk, and the same text its editor round-trips. There is no separate JSON
document model to learn.

```markdown
---
title: Arrival
label: Chapter
---

The boat came in at dusk, and nobody on the quay pretended otherwise.

*Later.*

---

She counted the lamps twice before she believed the number.
```

| Front matter key | Meaning |
|---|---|
| `title` | The chapter's title. Falls back to the chapter id. |
| `label` | What the reader calls this unit — `Chapter`, `Part`, `Read`. Default `Chapter`. |

Body rules (the full set is in [`authoring-stories.md`](authoring-stories.md)):

| You write | You get |
|---|---|
| A blank-line-separated paragraph | a paragraph block |
| `*emphasis*`, `**strong**` | inline styling, preserved with word-level audio sync |
| `---` on its own line | a scene break |
| `*A single italic line.*` | a display beat |
| `![alt](url)` | an image block |
| `> **Speaker (12:04):** text` | a message block |

**Ids** — book and chapter ids are 1-64 characters of lowercase letters, digits
and hyphens, starting with a letter or digit. They are URL segments and storage
keys. A bad id is rejected rather than sanitised: silently renaming
`The Keepers` to `the-keepers` would break every link you already have.

---

## Ownership: `managed`

```json
{ "contractVersion": 1, "managed": true, "source": { "url": "...", "system": "Acme CMS" } }
```

`managed` defaults to **`true`**, meaning *your system owns this*. The book is
recorded with `origin: "sync"` and a source of `kind: "api"`, and StoryLark's
admin portal shows it read-only with a *"managed externally — edit at source"*
notice naming your system. Every portal write route answers:

```
409 { "error": "managed_externally",
      "message": "…is managed externally — edit it at source…",
      "origin": "sync",
      "syncSource": { "kind": "api", "url": "…", "system": "Acme CMS" } }
```

Set `managed: false` if you want the portal to stay editable — appropriate when
you are an operator scripting against your own library rather than an external
system that will push again. That records `origin: "portal"` and no external
source.

`source` is optional and carries no credential. `source.url` is your canonical
page for the book, `source.system` is your system's name for itself. Both appear
verbatim in the portal's refusal message, which is what turns *"edit at source"*
into usable advice.

### The one thing this API will not overwrite

A book that a **pull connector** owns — synced from a git repo or a JSON feed
(`syncSource.kind` of `git` or `feed`) — is refused with the same
`409 managed_externally`. The next sync would silently revert your push, so the
two systems would fight. Pick one owner per book.

---

## Change detection

```bash
curl -H "X-Admin-Key: $KEY" https://app.example.com/api/content/v1/catalogue
```

```json
{
  "contractVersion": 1,
  "libraryVersion": 42,
  "announceVersion": 41,
  "books": [
    {
      "id": "the-keepers",
      "title": "The Keepers",
      "origin": "sync",
      "writableByApi": true,
      "syncSource": { "kind": "api", "url": "…", "system": "Acme CMS" },
      "chapters": [
        { "id": "arrival", "contentHash": "9f2c…", "wordCount": 1840, "hasAudio": true, "audioStale": false }
      ]
    }
  ]
}
```

`contentHash` is derived from the chapter's parsed blocks and title. Pushing
byte-identical text leaves it unchanged, so a diff against this listing tells you
exactly what to push. The whole listing is answered from one stored object, so
polling it for a thousand-story catalogue is cheap.

`writableByApi: false` means a pull connector owns that book — see above.

---

## Bulk: the onboarding day

### A batch of books

```bash
curl -X POST https://app.example.com/api/content/v1/books \
  -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  -d '{ "contractVersion": 1, "policy": "best-effort", "books": [ …, …, … ] }'
```

### A zip of the markdown-folder layout

```bash
curl -X POST "https://app.example.com/api/content/v1/import?policy=best-effort" \
  -H "X-Admin-Key: $KEY" -H "Content-Type: application/zip" \
  --data-binary @catalogue.zip
```

`multipart/form-data` with a `file` part works too, with `managed`, `policy` and
`narrate` as form fields.

The archive uses StoryLark's own layout — the same one the CLI reads:

```
books/the-keepers/book.json          optional: { "title", "author", "description" }
books/the-keepers/01-arrival.md      chapters, ordered by filename
books/the-keepers/02-the-long-dark.md
books/a-short-story.md               a single-chapter book; its chapter id is "full"
```

The numeric prefix orders chapters and is stripped from the id, so
`02-the-long-dark.md` becomes chapter `the-long-dark`. Anything outside `books/`
is ignored and reported in an `ignored` array with the reason — an operator whose
42-book import came back with 41 should not have to go looking.

### The failure policy — and why it is what it is

`policy` is `best-effort` (the default) or `all-or-nothing`.

**`best-effort`** processes every book and reports per item. One malformed book
in fifty costs you that book, not the other forty-nine. This is the default
because onboarding is exactly where a single bad file is most likely — it is the
first time anybody has run that catalogue through StoryLark's parser — and
because refusing all fifty means the operator fixes one file, re-uploads fifty,
and discovers the *second* bad one. Books are independent units, so partial
success is a coherent state rather than a corrupt one.

The response is **`207 Multi-Status`** when anything failed, so your error
handling cannot mistake a partial result for a clean one:

```json
{
  "contractVersion": 1, "ok": false, "policy": "best-effort",
  "summary": { "books": 50, "booksSucceeded": 49, "booksFailed": 1,
               "chapters": 50, "chaptersSucceeded": 49, "chaptersFailed": 0, "chaptersWithheld": 0 },
  "results": [
    { "bookId": "story-16", "ok": true, "created": true,
      "chapters": [ { "chapterId": "full", "ok": true, "created": true, "contentHash": "…", "wordCount": 900 } ] },
    { "bookId": "story-17", "ok": false, "chapters": [],
      "error": "unclosed_frontmatter",
      "message": "story-17/full: The front matter block starts with --- but never closes. Add a closing --- line.",
      "errors": [ { "code": "unclosed_frontmatter", "message": "The front matter block starts with --- but never closes. Add a closing --- line.", "file": "story-17/full", "line": 1 } ] }
  ],
  "libraryVersion": 51,
  "narration": { "queued": 49, "batchId": "nb_…", "message": "…" }
}
```

### Content validation — one gate, one vocabulary

Every chapter is judged by StoryLark's single content validator
(`storylark-contracts/content`) — the same implementation the admin portal's
editor and a repo sync call, so the same bad file produces the **same stable
error code and the same message** whichever door it arrives through. Only the
rendering differs: this API returns `422` with the error body (and the full
structured list in `errors`, each entry carrying `code`, `message`, and a
`file`/`line` where one can be named); the portal shows the same errors inline;
a sync skips the file and lists it.

Codes you can program against: `empty_chapter`, `too_large`,
`unclosed_frontmatter`, `no_prose`, `missing_storylark_block`,
`invalid_storylark_block`, `missing_field`, `unknown_type`, `type_mismatch`,
`invalid_id`, `id_mismatch`, `invalid_order`, `order_tie`, `invalid_publish`,
`invalid_title`, `invalid_cover`, `invalid_contract_version`,
`unsupported_contract_version`.

Markdown may carry the optional namespaced `storylark:` frontmatter block (see
[`authoring-stories.md`](authoring-stories.md#the-storylark-block--declaring-content-explicitly)).
It is not required here — the URL and payload already state the identity — but
when present it is validated strictly and must agree with the address it
arrived at (`id_mismatch` otherwise). Two consequences worth knowing:

- **`storylark.publish: false` withholds the chapter**: it validates, nothing
  is written, the per-chapter result carries `withheld: true` and the summary
  counts it in `chaptersWithheld`. An already-published copy is left untouched.
- **When every chapter in a push declares `storylark.order`**, that order —
  not wire position — decides the book's chapter order. Ties are an
  `order_tie` error and reject that book.

**`all-or-nothing`** validates every book and chapter first and writes nothing at
all if any of them fails — `422 batch_rejected`, and the library is untouched.
That covers every failure a caller can cause: bad ids, broken front matter, an
empty chapter, an oversized file, a book a pull connector owns.

**What `all-or-nothing` cannot do**, stated plainly rather than discovered: it
cannot roll back writes that already succeeded if *storage itself* fails
part-way through. The content store is object storage with no transaction. A
storage failure mid-batch leaves the books written so far written, and the
response reports exactly which those were (`error: "write_failed"` on the rest).
Retrying the same batch is safe — every write is an idempotent upsert keyed by
book and chapter id.

The single-book `PUT` endpoints use `all-or-nothing` implicitly: one book is not
a batch, and a half-written book is not a useful outcome.

### Limits

From `GET /api/content/v1`:

| Limit | Default |
|---|---|
| `maxBooksPerRequest` | 200 |
| `maxChaptersPerRequest` | 2000 |
| `maxChapterBytes` | 2,000,000 |
| `maxImportBytes` | 64 MB |
| `maxImportEntries` | 4096 |

Exceeding one is a `413 too_large` naming the limit. Split and repeat — each
request is independent, and pushing the same content twice is a no-op.

---

## Narration

**This is the part that is not instant, and it is worth reading before you ship
an integration.**

StoryLark reads *and narrates*. Pushing text does not produce audio, and it
cannot: no StoryLark deployment can run the text-to-speech model.

- A **Cloudflare Worker** cannot — no filesystem for the ~90MB of model weights,
  no native ONNX runtime, no `ffmpeg`, and a CPU budget measured in seconds
  against a job measured in minutes.
- The **Node/Azure** entry does not either — its dependencies are the web
  framework, the database driver and the blob client. The model, the forced
  alignment and the audio stitching live in StoryLark's publish pipeline,
  alongside `ffmpeg` and the storage credentials.

So every push **queues** the narration it invalidated, and the response says how
much:

```json
"narration": {
  "queued": 49,
  "batchId": "nb_m6qz1k_1a2b3c4d5e",
  "message": "49 chapters queued for narration. No StoryLark deployment can run the narration model — a worker drains this queue: `node packages/pipeline/narrate.mjs --brand <id>`. Watch it at GET /api/admin/narration."
}
```

Send `"narrate": false` to skip queueing — appropriate for a text-only library,
or when you narrate elsewhere and push the audio yourself.

Until a worker runs, the chapters carry `audioStale: true` (or `hasAudio: false`)
in the catalogue and in the reader, which is StoryLark saying so rather than
hiding it. Watch progress at `GET /api/admin/narration`; the queue is documented
in [`narration-queue.md`](narration-queue.md).

---

## Corrections vs publications

Every push moves the library version, so readers re-fetch and see your change.
Whether it also *announces* — a push notification, and the app's "new content"
badge — is separate:

| You send | Effect |
|---|---|
| `"correction": true` on a chapter | Text updates silently. No notification, no badge. |
| `"correction": false` | A publication. Notifies and badges. |
| omitted | `true` for a chapter that already existed, `false` for a new one. |

The default is the safe one. Accidentally announcing a typo fix to every
subscriber is the failure worth defaulting against.

---

## Errors

Every error is `{ "contractVersion": 1, "error": "<slug>", "message": "<prose>" }`.
The message is written to be shown to a human; the slug is what you branch on.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `contract_version_required` | No integer `contractVersion` in the body. |
| 400 | `contract_version_unsupported` | This deployment does not speak that version. |
| 400 | `bad_request` | Malformed body — the message says which field. |
| 400 | `invalid_book_id` / `invalid_chapter_id` | See the id rules above. |
| 400 | `duplicate_chapter` | The same chapter id appears twice in one push. |
| 401 | `unauthorized` | Missing or wrong `X-Admin-Key`, and no admin session. |
| 403 | `missing_csrf_header` | Cookie-authenticated request without `X-Requested-With: storylark`. |
| 404 | `not_found` | No such book or chapter to delete. |
| 409 | `managed_externally` | A pull connector owns this book. The message names it. |
| 413 | `too_large` | A limit was exceeded. The message names it. |
| 422 | `batch_rejected` | `all-or-nothing`, and something failed validation. Nothing was written. |
| 422 | `invalid_archive` | Not a readable zip. |
| 422 | `empty_import` | A readable zip holding no books in the expected layout. |
| 501 | `no_content_store` | The deployment has no writable content storage bound. |
| 207 | — | A best-effort batch that partly succeeded. Read `results`. |

Everything is **idempotent**: pushing the same content twice produces the same
content hash and no second revision. Retrying a failed or timed-out request is
always safe.

---

## A worked integration

A publisher's release step, in full:

```js
const BASE = 'https://app.example.com/api/content/v1';
const headers = { 'X-Admin-Key': process.env.STORYLARK_ADMIN_KEY, 'Content-Type': 'application/json' };

// 1. What does StoryLark already have?
const catalogue = await (await fetch(`${BASE}/catalogue`, { headers })).json();
const live = new Map(
  catalogue.books.flatMap((b) => b.chapters.map((c) => [`${b.id}/${c.id}`, c.contentHash]))
);

// 2. Push only what moved. (contentHash is StoryLark's; compare by pushing and
//    reading the result, or keep your own record of what you last sent.)
for (const book of await ourCms.publishedBooks()) {
  const chapters = book.chapters
    .filter((ch) => ch.changedSinceLastPublish)
    .map((ch) => ({ id: ch.slug, markdown: ch.toMarkdown(), correction: ch.isCorrection }));
  if (chapters.length === 0) continue;

  const res = await fetch(`${BASE}/books/${book.slug}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      contractVersion: 1,
      title: book.title,
      author: book.author,
      description: book.blurb,
      source: { url: `https://press.example.com/books/${book.slug}`, system: 'Acme CMS' },
      chapters,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${book.slug}: ${body.error} — ${body.message}`);
  console.log(`${book.slug}: ${body.summary.chaptersSucceeded} chapter(s), ${body.narration.queued} queued for narration`);
}
```

Then, wherever your machine with the model runs (a CI job, a laptop, a box in the
corner), drain the narration queue:

```bash
ADMIN_KEY=… node packages/pipeline/narrate.mjs --brand your-brand --watch 60
```

---

## Related

- [`api.md`](api.md) — the rest of the deployment's HTTP surface.
- [`content-sync.md`](content-sync.md) — the two PULL connectors, if you would
  rather StoryLark read your repo or feed than have your system call it.
- [`narration-queue.md`](narration-queue.md) — the queue, the worker, and the
  progress view.
- [`authoring-stories.md`](authoring-stories.md) — the full markdown rules.
