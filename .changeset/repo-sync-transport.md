---
"storylark-contracts": minor
"storylark-worker": minor
"storylark-core": minor
---

The repo transport, sync triggers, per-book presentation and scoped
content-API tokens (AB#7420 — content-management rework, wave 2).

- **contracts**: the vocabulary gains the two manifest-context codes —
  `unknown_book` (a chapter naming a book neither held nor declared by the
  same arrival; arrivals are evaluated as a SET, so a `type: book` file
  anywhere in the batch satisfies the reference) and `book_owned_elsewhere`
  (the first writer owns a `bookId`; a different source is rejected with the
  owner named). The stored manifest now joins the `order_tie` check
  (`existingChapters`): an order an incumbent declared last month collides
  exactly as one declared in the same batch, same code, same message —
  re-declaring the order a chapter already owns is not a tie. Transport-
  supplied ids are validated by the gate itself, `type: book` must name its
  book in repo mode, and `isRepoCandidate` settles candidacy so a broken
  frontmatter fence that mentions `storylark:` is rejected rather than
  silently ignored.
- **worker**: a deployment now syncs a git repository itself. The repo
  transport fetches the provider's archive over HTTPS (a Worker cannot shell
  to `git`), unpacks it with the existing zip reader, walks the configured
  path and hands every candidate to the one gate — no validation of its own,
  no inference. Three trigger tiers: a signature-verified webhook
  (`POST /api/content/v1/sync/webhook` — unsigned or forged deliveries are
  rejected), a daily pull as a second job on the EXISTING update-check cron
  (schedule unchanged; the interval gates per connection), and Sync now, with
  concurrent runs collapsed. A chapter present in the manifest and absent
  from the arrival is reported `missing` and NEVER auto-deleted; removal is
  the operator's one click, running the ordinary recoverable delete. Images
  are ingested with the portal upload's exact allowlist (SVG refused) and
  references rewritten to the deployment's own copies. GitHub ships first,
  behind a two-function provider seam (archive URL + webhook verify), so the
  next provider is a driver, not a refactor. Migration 0009 adds the
  connection state and `content_api_tokens`; scoped bearer tokens
  (`Authorization: Bearer sct_…`) authenticate the content API and nothing
  else, individually revocable with last-used visibility. Books gain the
  derived `single` presentation flag, recomputed on every chapter-set write.
- **core**: the Connections section — the three-way content-source choice
  (portal / repo / CMS-API; a primary source, never a lock), the repo
  connection form (SSH declined in words, dry-run gate: a repo that does not
  validate cannot be connected), sync status and report with the missing
  list, webhook secret shown exactly once, and content-API token management.
  A mixed library renders per book: a `single` book opens straight into its
  text, a multi-chapter book keeps its chapter list, whatever the
  library-wide layout says; manifests without the flag behave exactly as
  before.

Pre-strict content is untouched: existing deployments' chapters keep saving,
syncing and rendering exactly as they did, and `deployment.json`'s legacy
`sync` block keeps working (`contentSource.repo` supersedes it when present).
