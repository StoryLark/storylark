-- Password recovery. Additive to 0001–0003: no existing table or column is
-- touched. A reset "request" writes two rows keyed by token_hash — one for the
-- emailed link token (sha256 of a random token) and one for the 6-digit code
-- the user can type back into the app (a code_hash namespaced by user id, the
-- same trick magic_links uses so a code can't be verified against the wrong
-- account). Both point at a user_id, both are single-use (used_at) and short-
-- lived (expires_at, 30 min). Consuming either one burns every outstanding row
-- for that user, so a completed reset invalidates the other credential too.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);
