-- Bulk narration queue (AB#7412 — plan §8, item 4: "the genuinely expensive
-- piece of serving a large publisher").
--
-- ── Why a queue exists at all ───────────────────────────────────────────────
-- A thousand stories is a thousand TTS runs. Synthesising them inside the
-- request that imported them is not slow-but-workable, it is impossible:
-- Cloudflare Workers cannot run the model at all (no filesystem, no native ONNX
-- runtime, a CPU ceiling measured in seconds), and even the Node entry ships no
-- TTS dependency — the model, ffmpeg and the storage credentials all live in
-- `packages/pipeline`, which is where narration has always actually happened.
--
-- So the deployment holds the QUEUE and the pipeline holds the WORK. That split
-- is stated in the data rather than hidden: a job row records what needs
-- narrating and what happened to it, and `packages/pipeline/narrate.mjs` claims
-- rows, does the synthesis where the model is, and reports back. The portal
-- polls the same rows, so "what is pending, what is running, what failed and
-- why" has one answer on every platform.
--
-- ── Why not a per-book flag on the manifest ─────────────────────────────────
-- Because the interesting states are per attempt, not per chapter: which worker
-- has it, how long it took, how many times it has failed and with what message.
-- A manifest is a published artifact readers fetch; a work queue is operational
-- state. Putting the second inside the first would mean every reader downloads
-- the operator's error messages.
--
-- Additive to 0001-0007: no existing table or column is touched.

CREATE TABLE narration_batches (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  -- Who asked. An account email for a portal request, 'content-api' for a push,
  -- 'cli' for a key-authenticated call — the same actor vocabulary revisions use.
  created_by TEXT,
  -- Human label, e.g. "bulk import: 42 books". Shown in the portal's job list.
  label TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  -- Set once the operator has been told this batch finished, so a completion
  -- notification is sent exactly once even though several workers can each be
  -- the one that finishes the last job.
  notified_at INTEGER
);

CREATE TABLE narration_jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  -- The content hash the job was enqueued FOR. A worker that finishes against a
  -- hash the chapter no longer has is reporting narration of text that has since
  -- been edited, and the completion is refused rather than written — otherwise a
  -- slow TTS run would silently overwrite a newer edit's staleness flag with
  -- audio of the older words.
  content_hash TEXT NOT NULL,
  -- pending | running | done | failed | cancelled
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  -- Which worker claimed it, in that worker's own words (hostname, runner id).
  worker TEXT,
  error TEXT,
  -- Characters of speakable text, so the queue can give a time ESTIMATE from
  -- measured throughput rather than from a guess. See lib/narration.ts.
  char_length INTEGER NOT NULL DEFAULT 0,
  -- Filled in on completion: the produced audio's length, and how long the
  -- synthesis itself took. The second is what makes the estimate real.
  duration_ms INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT
);

-- The claim query: oldest pending first.
CREATE INDEX idx_narration_jobs_status ON narration_jobs(status, enqueued_at);
-- The portal's per-batch view, and the "is this batch finished" check.
CREATE INDEX idx_narration_jobs_batch ON narration_jobs(batch_id);
-- Enqueue de-duplication: one live job per chapter (see lib/narration.ts, which
-- updates an existing pending row rather than inserting a second one).
CREATE INDEX idx_narration_jobs_chapter ON narration_jobs(book_id, chapter_id, status);
