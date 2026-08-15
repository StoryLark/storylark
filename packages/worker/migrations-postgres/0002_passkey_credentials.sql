-- Postgres dialect — mirrors migrations/0002_passkey_credentials.sql.
CREATE TABLE passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);
CREATE INDEX idx_passkey_credentials_user ON passkey_credentials(user_id);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,
  user_id TEXT,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
