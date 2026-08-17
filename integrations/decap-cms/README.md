# Decap CMS — reference integration

**Status:** reference integration, proven end to end against the real gate.
Not a StoryLark product, not deployed anywhere, not a dependency of the
Worker. See `storylark-ops/pmo/cms-build-or-buy.md` for why this exists
instead of a StoryLark-built CMS: 12-18 months to reach parity with a free
tool competes with the actual differentiator, so the plan is "days not
months" reference integrations against the repo-sync transport instead.

## The claim this proves

[Decap CMS](https://decapcms.org/) is a free, open-source, **git-based** CMS:
authors edit through a browser UI, and on save Decap commits a markdown file
directly to a connected git repository. That is exactly the input
StoryLark's repo-sync transport already consumes (`repo-connection-standard-v1.md`,
`packages/worker/src/lib/repo-sync.ts`). So plugging Decap in front of a
StoryLark-connected repo requires:

- **Zero changes to the StoryLark Worker.**
- **Zero changes to the content contract** (`packages/contracts/content.mjs`).
- **Zero StoryLark-specific code in Decap** — `admin/config.yml` in this
  directory is an ordinary Decap config using stock widgets
  (`object`, `string`, `number`, `boolean`, `hidden`, `markdown`, `image`).
  Nothing here is a StoryLark plugin or a custom widget.

That's the "one gate, many transports" architecture (SCF v1 §1) working as
designed: repo-sync doesn't know or care that a human, a script, or Decap's
UI produced the commit. It only knows the gate's verdict on the bytes.

`verify-frontmatter.mjs` in this directory is the load-bearing proof — see
"Proof" below.

## Setup

1. **Connect a repo to StoryLark first**, the ordinary way — admin portal →
   Content source → Connections (wave 2, already shipped). Public repo needs
   no token; a private repo needs a **read-only** token. This connection is
   unrelated to Decap and is configured exactly as it would be with no CMS
   in the picture at all.

2. **Add Decap to the same repo.** Drop `admin/config.yml` (this directory)
   and an `admin/index.html` (Decap's standard entry point — see
   [Decap's install docs](https://decapcms.org/docs/add-to-your-site/)) into
   the repo, at whatever path your site serves `/admin/` from. Edit the
   `backend.repo` line in `config.yml` to point at your repo.

3. **Set the `folder` paths to match, or match, StoryLark's `path` setting.**
   `config.yml` here writes to `content/books/` and `content/chapters/`. If
   the StoryLark connection's `path` is narrower than the repo root, make
   sure Decap's collection folders sit inside it — `path` is a scoping
   optimisation on the StoryLark side (repo-connection-standard-v1.md §2.1),
   not a safety mechanism, but content Decap writes outside it simply won't
   be seen until the connection's `path` is widened or removed.

4. **Authors use Decap's browser UI at `/admin/`** to create/edit book and
   chapter entries. Decap commits the resulting markdown straight to the
   branch — StoryLark never sees Decap; it only ever sees the repository.

5. **StoryLark picks the commit up with no new code**, through whichever
   trigger the connection already has configured:
   - **Sync now** — a button in the portal, immediate.
   - **Webhook** — seconds, if a webhook secret is configured on the provider.
   - **Scheduled** — daily, on by default, zero setup.

   Each of these calls the exact same `runRepoSync` → `validateChapterCandidate`
   path a hand-written commit would.

## Authentication — two separate credentials, never one

**StoryLark's repo-sync token is read-only** (repo-connection-standard-v1.md
§1, §3.1) — it fetches an archive over HTTPS and never writes back.

**Decap needs its own, separate, write-capable credential** to commit to the
repo on the author's behalf — a GitHub OAuth app (`backend: github` in
`config.yml`, requiring an OAuth provider such as
[decap-proxy](https://github.com/decaporg/decap-proxy) or Netlify) or
Netlify Identity + git-gateway. **These must never be the same credential.**
Giving StoryLark's sync token write scope, or reusing Decap's write-capable
token as StoryLark's sync credential, would violate the repo-connection
standard's core premise — "git is the CMS; StoryLark is a reader of it,
always" (§1) — even though both symptoms would look identical from inside
StoryLark (nothing there ever holds a write credential, so nothing there
would notice).

## What StoryLark does with what Decap commits

Nothing different from any other commit. On sync, repo-sync:

1. Fetches the branch as an archive over HTTPS.
2. Walks every `.md` file under the connection's `path`.
3. For each one, checks for a `storylark:` block
   (`isRepoCandidate` / `readStorylarkBlock` in `content.mjs`) — a file with
   no block, Decap-authored or not, is simply not StoryLark content and is
   silently ignored, per SCF §2.
4. Hands every candidate to `validateChapterCandidate` /
   `validateBookCandidate` — the same function the portal's save and the
   public content API call.
5. Writes what passed; reports what didn't, per-file, with the same error
   code and message any other transport would get for the same bytes.

If Decap's config drifts from the contract — a typo'd id, a missing `order`
— the sync report shows exactly the same `invalid_id` / `missing_field` /
etc. rejection a hand-edited file would get. There is no Decap-specific
error path, because there is no Decap-specific code.

## `admin/config.yml`

Two collections, mapping directly onto SCF v1 §4's types:

| Decap collection | Folder | `storylark.type` | Notes |
|---|---|---|---|
| `books` | `content/books/` | `book` | Metadata only. `type`/`contractVersion` are `hidden` widgets — authors never see or set them, but the value is still written into the file. Body must stay empty; the CMS doesn't enforce that (Decap has no such widget) — the gate does, on sync (`type_mismatch` if prose is present). |
| `chapters` | `content/chapters/` | `chapter` | `order` is a plain integer field — Decap ties are NOT checked client-side; the gate's `order_tie` check on sync is the only place a collision is caught, same as any other transport. `publish` is a checkbox; unchecking it withholds the chapter and writes nothing (SCF §3.5) — proven in the proof script below. |

`type: story` (a standalone piece needing no book) isn't wired up as a third
collection here only because two collections were enough to prove the
mechanism; adding one is the same five-field pattern as `chapters` minus
`book`/`chapter`/`order`.

Nothing in `config.yml` invents syntax — it's the documented Decap schema
(`backend`, `media_folder`/`public_folder`, `collections[].folder`/`fields`,
the `object` widget for nesting). See
[Decap's configuration docs](https://decapcms.org/docs/configuration-options/)
and [widget reference](https://decapcms.org/docs/widgets/).

## Proof

`verify-frontmatter.mjs` constructs the exact bytes Decap's `object`/
`string`/`number`/`boolean`/`hidden` widgets would write for a filled-in
`books` entry and two filled-in `chapters` entries (one published, one with
`publish` unchecked), then calls the REAL, unmodified
`validateChapterCandidate` from `packages/contracts/content.mjs` — the same
call `repo-sync.ts` makes (`{ requireBlock: true }`). It is not a mock and
does not stub the validator.

Run it:

```
node integrations/decap-cms/verify-frontmatter.mjs
```

**Actual result, this run:** all three cases `PASS`, zero errors, exit code
`0`. No change was made to `content.mjs` to get there.

This script can be deleted once you've verified it yourself, or kept — it
has no dependency on anything outside `packages/contracts`, so it stays
correct as long as the contract does.
