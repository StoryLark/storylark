/**
 * Full current schema, mirrored from worker/migrations/*.sql (0001_init.sql +
 * 0002_passkey_credentials.sql + 0003_password_auth.sql + 0004_password_resets.sql +
 * 0005_rate_limits.sql + 0006_user_preferences.sql + 0007_admin_accounts.sql +
 * 0008_narration_queue.sql)
 * so the worker can
 * bootstrap its own database via POST /api/admin/setup when API-token D1
 * access is unavailable. Keep in sync with the migration files — this is the
 * cumulative result of applying all of them in order, not just the first one.
 */
export const INIT_SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  username TEXT COLLATE NOCASE,
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;

CREATE TABLE oauth_identities (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (provider, provider_user_id)
);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE progress (
  user_id TEXT NOT NULL REFERENCES users(id),
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'read',
  char_offset INTEGER NOT NULL DEFAULT 0,
  audio_ms INTEGER NOT NULL DEFAULT 0,
  percent REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id, chapter_id)
);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  char_offset INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_bookmarks_user ON bookmarks(user_id, book_id);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE library_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  manifest_version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT INTO library_state (id, manifest_version, updated_at) VALUES (1, 0, 0);

CREATE TABLE passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_passkey_credentials_user ON passkey_credentials(user_id);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  prefs TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE admin_setup_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_admin_setup_tokens_expires ON admin_setup_tokens(expires_at);

CREATE TABLE admin_recovery_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE narration_batches (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  label TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER
);

CREATE TABLE narration_jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
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
`;
