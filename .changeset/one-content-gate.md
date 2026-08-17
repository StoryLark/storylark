---
"storylark-contracts": minor
"storylark-worker": minor
"storylark-core": minor
---

ONE content gate for every transport, plus portal book lifecycle (AB#7420 —
content-management rework, wave 1).

- **contracts**: new `storylark-contracts/content` — the single content
  validator every transport calls. It reads the namespaced, additive
  `storylark:` frontmatter block (`type` / `book` / `chapter` / `order` /
  `publish` / `title` / `cover` / `contractVersion`), validates strictly
  (no inference, no repair: missing required fields, bad ids, non-integer or
  tied `order`, URLs as covers are all errors with stable codes, messages and
  line numbers), and normalises with the spec defaults (`publish: true`,
  `contractVersion: 1`). `requireBlock` enforces the repo rule — a file
  without a `storylark:` block is not StoryLark content — while portal/API
  candidates carry transport identity, which is what keeps every pre-block
  chapter in existing deployments valid.
- **worker**: the public content API and the portal's admin content routes both
  validate through the shared gate. Rejections carry the gate's structured
  `errors` list; the top-level `error` code is now the gate's specific stable
  code (e.g. `unclosed_frontmatter`) instead of the old umbrella
  `invalid_markdown`. `storylark.publish: false` is withheld — accepted,
  reported (`withheld`, `summary.chaptersWithheld`), nothing written — and
  `storylark.title` overrides the top-level title on save. When every chapter
  in a push declares `storylark.order`, that order decides the book's chapter
  order; ties reject the book without costing the rest of the batch.
- **core**: the portal can finally create and delete books/stories. "New
  book"/"New story" (id, title, author, description, cover) and typed-
  confirmation "Delete" call the existing public `/api/content/v1` routes
  authenticated by the admin session — one implementation, two credentials,
  the same discipline theme import uses. Created books are `managed: false`
  (portal-owned, editable); a new story opens straight into the editor.

Pre-contract content is untouched: markdown without a `storylark:` block keeps
saving, syncing and rendering exactly as before.
