-- Postgres dialect — mirrors migrations/0004_password_resets.sql.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);
