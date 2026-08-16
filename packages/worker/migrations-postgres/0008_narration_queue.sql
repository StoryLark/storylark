-- Postgres dialect — mirrors migrations/0008_narration_queue.sql, which carries
-- the full reasoning. Timestamps are BIGINT unix milliseconds, matching every
-- other table on this side; counters stay INTEGER so the Database seam hands
-- route code the same JS types on both drivers (src/db/postgres.ts registers a
-- type parser for OID 20 so a BIGINT reads back as a number, not a string).
CREATE TABLE narration_batches (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  created_by TEXT,
  label TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  notified_at BIGINT
);

CREATE TABLE narration_jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  enqueued_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  worker TEXT,
  error TEXT,
  char_length INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT
);

CREATE INDEX idx_narration_jobs_status ON narration_jobs(status, enqueued_at);
CREATE INDEX idx_narration_jobs_batch ON narration_jobs(batch_id);
CREATE INDEX idx_narration_jobs_chapter ON narration_jobs(book_id, chapter_id, status);
