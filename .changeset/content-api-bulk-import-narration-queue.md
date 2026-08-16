---
'storylark-worker': minor
'storylark-core': minor
'storylark-pipeline': minor
---

Add the public content API, bulk import, and the bulk narration queue — plan §8
items 1, 3 and 4.

**Content API (`/api/content/v1`).** A documented, versioned PUSH contract an
external publishing system integrates against once. Until now content only
arrived through the CLI or through the two PULL connectors; there was no stable
way for a publisher's own release step to call StoryLark. The major version is in
the path and in every request body (`contractVersion`, required — a missing one
is a hard 400), following the same rule `packages/contracts/validate.mjs` applies
to brand/presentation/deployment files: additive fields never move it, unknown
request fields are ignored rather than rejected. Auth is `X-Admin-Key` with an
admin session as the second door, matching `POST /api/admin/publish`. Content
pushed here is `origin: sync` with `syncSource.kind: "api"` by default, so the
portal shows it read-only and names the pushing system — plan §8's ownership rule
applied to the third arrival route — and `managed: false` opts out. The API in
turn refuses to overwrite a book a PULL connector owns, because the next sync
would revert the push. Every write lands in the same `saveChapter()` the portal's
editor calls; there is no second content model and no second write path. Full
integrator documentation in `docs/content-api.md`.

**Bulk import.** `POST /api/content/v1/books` takes an array; `POST
/api/content/v1/import` takes a zip of the ordinary markdown-folder layout,
unpacked with the dependency-free zip codec already in `storylark-contracts` so
it works inside a Worker. Both run through the same `pushBooks()`, with an
explicit, documented failure policy: `best-effort` (the default) reports per
item and answers `207` when part of a batch fails, so one malformed book in fifty
costs that book and not the other forty-nine; `all-or-nothing` validates
everything before writing anything and is honest that object storage has no
transaction, so a storage failure mid-batch is reported per book rather than
claimed to have rolled back. Archive entries that are not books come back in an
`ignored` list with a reason each.

**Bulk narration queue.** New `narration_jobs` / `narration_batches` tables
(migration 0008, both dialects), a queue engine, `/api/admin/narration/*`, a
portal card, and `packages/pipeline/narrate.mjs` — a real worker that claims
jobs, synthesises with the same `synthesizeChapter`/`stitchChapter` `publish.mjs`
uses, uploads to the same content-hashed keys, and reports back so the deployment
updates its own manifest and clears `audioStale`. Portal saves, reverts and every
API push enqueue automatically, idempotently per chapter. Progress carries a time
estimate measured from this deployment's own completed jobs, and is `null` — with
that stated — until something has actually completed. Claims are atomic, stale
claims are reclaimed after 30 minutes, and a completion whose content hash no
longer matches the live chapter is refused rather than published against words it
does not match. Batch completion emails the operator once, following the existing
`update-check` notification pattern; it is deliberately not a reader push, since
narration is never an announcement.

The queue is honest about the platform split rather than hiding it: **no**
deployment can narrate — a Worker cannot run the model at all, and the Node entry
ships no TTS dependency — so `GET /api/admin/narration` returns
`runtime.canProcessInDeployment` with the platform's own reason and the command
that does the work, and the portal renders those rather than a hard-coded
sentence. Documented in `docs/narration-queue.md`.

Also closes the verification gap AB#7422 recorded: the `409 managed_externally`
enforcement is now proven at the HTTP level on the Node/Azure stack — a real
PostgreSQL server, the real shipped `migrate-postgres.mjs`, the real
`postgresDatabase()` driver and a real socket — in
`packages/worker/test/node-http-readonly.test.mjs`.
