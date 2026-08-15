-- StoryLark initial schema (Postgres dialect — mirrors migrations/0001_init.sql).
-- All timestamps are unix milliseconds. citext gives SQLite's COLLATE NOCASE
-- semantics for email/username with no query-level changes.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email CITEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT
);

CREATE TABLE oauth_identities (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (provider, provider_user_id)
);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email CITEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE progress (
  user_id TEXT NOT NULL REFERENCES users(id),
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'read',
  char_offset BIGINT NOT NULL DEFAULT 0,
  audio_ms BIGINT NOT NULL DEFAULT 0,
  percent REAL NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, book_id, chapter_id)
);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  char_offset BIGINT NOT NULL DEFAULT 0,
  note TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_bookmarks_user ON bookmarks(user_id, book_id);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE library_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  manifest_version INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
INSERT INTO library_state (id, manifest_version, updated_at) VALUES (1, 0, 0);
