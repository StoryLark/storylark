-- Postgres dialect — mirrors migrations/0009_content_connections.sql, which
-- carries the full reasoning. Timestamps are BIGINT unix milliseconds, matching
-- every other table on this side.

CREATE TABLE content_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config TEXT,
  repo_token TEXT,
  webhook_secret TEXT,
  running_since BIGINT,
  last_sync_at BIGINT,
  last_sync TEXT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE content_api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  created_by TEXT,
  last_used_at BIGINT,
  revoked_at BIGINT
);

CREATE UNIQUE INDEX idx_content_api_tokens_hash ON content_api_tokens(token_hash);
