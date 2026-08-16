# The bulk narration queue

**What it is:** a list, held by the deployment, of chapters whose audio does not
match their text — plus a worker that drains it and a portal card that watches it.

**Why it exists:** narrating a catalogue is the expensive part of running
StoryLark at scale. A thousand stories is a thousand text-to-speech runs. Doing
that inside the request that imported them is not slow-but-workable; it is
impossible. So the work is tracked instead of promised.

---

## The constraint, first

**No StoryLark deployment can narrate.** Not "Cloudflare can't and Azure can" —
neither can, and only the reason differs:

- A **Cloudflare Worker** cannot run the Kokoro model at all. There is no
  filesystem for the ~90MB of weights, no native ONNX runtime, no `ffmpeg` to
  stitch chunks, and a CPU budget measured in seconds against a job measured in
  minutes.
- The **Node entry** (`platforms/azure/server.mjs`) *could* host a model, and
  deliberately does not: its dependencies are the web framework, the Postgres
  driver and the blob client. Text-to-speech, forced alignment and audio
  stitching live in `packages/pipeline`, together with `ffmpeg` and the storage
  credentials — which is where narration has always actually happened.

So: **the deployment owns the queue, the pipeline owns the work.** The portal
says exactly this, in the deployment's own words, rather than showing a button
that would spin and lie. `GET /api/admin/narration` returns

```json
"runtime": {
  "platform": "cloudflare",
  "canProcessInDeployment": false,
  "reason": "A Cloudflare Worker cannot run the narration model: …",
  "runCommand": "node packages/pipeline/narrate.mjs --brand <brand-id>",
  "workerAuthConfigured": true
}
```

`canProcessInDeployment` is a field rather than an assumption so that the day an
in-deployment narrator becomes possible, the portal stops saying it isn't without
anyone editing a sentence in the browser bundle.

---

## The shape

```
enqueue → pending → (a worker claims it) → running → done
                                                  ↘ failed → (retry) → pending
```

Work is enqueued automatically by everything that invalidates audio:

| What happened | What gets queued |
|---|---|
| A chapter saved in the admin portal | that chapter |
| A chapter reverted to an earlier revision | that chapter |
| A push over the [content API](content-api.md) | every chapter the push wrote |
| A bulk import (zip or batch) | every chapter it wrote |
| **Queue everything that needs it** in the portal | every chapter whose audio is missing or stale |

Enqueuing is **idempotent per chapter**: a chapter that already has a pending job
has that job updated to the new content hash rather than gaining a second one, so
an author saving five times while drafting leaves one job — for the text they
stopped on.

`CLI publishes are not queued.` `publish.mjs` narrates as it goes; it has the
model. The queue is for text that arrived somewhere that does not.

---

## Running a worker

```bash
export ADMIN_KEY=…            # the same key publish.mjs uses to notify
node packages/pipeline/narrate.mjs --brand your-brand
```

It claims jobs, reads each chapter's published blocks from the public content
origin, synthesises with the brand's narrator voice (and any extra voices),
stitches the audio, uploads it under the same content-hashed keys `publish.mjs`
writes, and reports back — at which point the deployment updates the manifest and
clears `audioStale`.

| Flag | Meaning |
|---|---|
| `--brand <id>` | Required. The same brand id `publish.mjs` takes. |
| `--max <n>` | Jobs claimed per round. Default 4. |
| `--watch [seconds]` | Keep polling instead of exiting when the queue empties. Default 30s. |
| `--worker <name>` | How this worker identifies itself. Default `<hostname>-<pid>`. |
| `--bucket <name>` | Content bucket/container. Default `<brand>-content`. |
| `--storage r2\|azure-blob` | Storage driver. Default `r2`, or `STORYLARK_STORAGE`. |
| `--local <dir>` | Mirror into a local directory instead of a remote bucket. |
| `--status` | Print the queue and exit. Claims nothing. |
| `--dry-run` | The same as `--status`. |
| `--no-audio-voices` | Primary narrator only; skip the brand's extra voices. |

Several workers can drain one queue at once. Claims are atomic — a conditional
`UPDATE … WHERE status = 'pending'`, so two workers racing for the same job
cannot both win — with no coordination between them.

### Where to run it

Wherever your publish already runs. A GitHub Actions job on a schedule, a laptop,
a box in the corner. The requirements are Node, `ffmpeg`/`ffprobe` on PATH,
network access to the deployment, and the storage credential the bucket needs.
`--watch` makes it a long-running drainer; without it, it drains what is pending
and exits (non-zero if anything failed, so a scheduled run fails loudly).

---

## Progress, and a time estimate that is real

`GET /api/admin/narration` returns counts per state, the characters of text still
outstanding, and:

```json
"charsPerSecond": 412.8,
"estimateSeconds": 1830
```

Both are **measured**, from the last 25 completed jobs on this deployment —
their character counts against their actual elapsed wall clock. Before anything
has completed, `estimateSeconds` is `null` and the portal says *"no time estimate
yet — nothing has finished on this deployment, so there is no measured speed to
work from"*. A number invented before the first measurement would be exactly the
false progress this queue exists to replace.

The estimate therefore reflects the machine actually doing the work: a laptop
running the local Kokoro model and a CI runner using Azure Speech produce very
different numbers, and neither has to be configured anywhere.

---

## Failure

Every failure is recorded on its job, with the worker's own message:

```
FAILED  the-keepers/arrival: ffmpeg is not installed on this worker.
```

The portal shows it inline with a **Retry** button; retrying keeps the attempt
counter, so a job failing forever is visible rather than looking new each time.

Two failures are produced by the deployment rather than the worker, and both
exist to avoid publishing audio that does not match its words:

- **The chapter changed while it was being narrated.** A job is enqueued for a
  specific `contentHash`. If the text moved before the worker reported back, the
  completion is refused (`409 stale_content_hash`), the audio is discarded, and
  the job is failed with that explanation. The edit that changed the text has
  already queued its own job, so the chapter is not stranded.
- **The chapter is gone.** Deleted while queued; the job fails saying so.

A worker that claims jobs and then dies does not pin them: any job held in
`running` for more than 30 minutes is returned to `pending` on the next claim. A
queue that looks busy while nothing is happening is worse than a slow one,
because it is indistinguishable from progress.

---

## Notification

When the last job in a batch finishes, the operator gets an email — once,
whichever worker happened to finish last:

> A narration batch has finished: **49 of 50** chapters now have audio.
> **1** failed. Open your site's `/admin` page to see which, and why.

This follows the existing operator-notification pattern exactly
(`lib/update-check.ts`): a Resend email to `ADMIN_EMAIL`, silently skipped when
`RESEND_API_KEY` or `ADMIN_EMAIL` is absent, never able to fail the request that
triggered it. The in-portal view always works regardless.

It is deliberately **not** a push notification to readers. `recordPublish()` is
what wakes phones, and narration finishing is not a publication — the words
readers were told about did not change. Every completion still moves
`libraryVersion`, so readers re-fetch the manifest and hear the new audio; none
of them moves `announceVersion`. That is the same correction rule the portal's
edits use, in [`api.md`](api.md).

---

## HTTP surface

All of it is at `/api/admin/narration`, gated by an admin session **or**
`X-Admin-Key` — the same two-door rule `POST /api/admin/publish` uses, because a
worker is headless by definition.

| Method & path | Behavior |
|---|---|
| `GET /api/admin/narration` | `{available, runtime, counts, charsRemaining, charsPerSecond, estimateSeconds, jobs[], batches[]}`. What the portal polls. |
| `POST /api/admin/narration/enqueue` | `{staleOnly?, bookIds?, chapters?, label?}` → queues work. Defaults to everything whose audio is missing or stale. `staleOnly: false` re-narrates regardless — what changing the narrator voice needs. |
| `POST /api/admin/narration/claim` | `{worker, max}` → the jobs this worker now owns, each with `contentUrl` to read and `audioKey`/`timingsKey` to write. |
| `POST /api/admin/narration/jobs/:id/complete` | `{audio, timings, durationMs, voices?, elapsedMs?, contentHash?}` → updates the manifest, clears `audioStale`, records the job. |
| `POST /api/admin/narration/jobs/:id/fail` | `{error}` → records why. |
| `POST /api/admin/narration/jobs/:id/retry` | Puts a failed or cancelled job back in the queue. |
| `DELETE /api/admin/narration/jobs/:id` | Cancels a job that has not started. A running one has to fail or finish. |

`GET` answers `{"available": false, "message": "…"}` — not a 500 — on a
deployment whose database has not run migration `0008_narration_queue.sql`. That
is a normal state during an update, and the message says which command fixes it.

---

## Storage

Two tables, `narration_jobs` and `narration_batches`, added by migration 0008 in
both dialects (`migrations/` for D1, `migrations-postgres/` for Postgres).

Operational state lives in the database rather than on the manifest on purpose:
the interesting facts are per attempt, not per chapter — which worker holds it,
how long it took, how many times it has failed and with what message. The
manifest is a published artifact every reader downloads; a work queue is not
something readers should be fetching.

---

## Related

- [`content-api.md`](content-api.md) — pushing content in, which is what fills
  this queue.
- [`voices.md`](voices.md) — narrator voices, and what each provider needs.
- [`content-pipeline.md`](content-pipeline.md) — how `publish.mjs` narrates
  during an ordinary publish.
