-- Passkey (WebAuthn) sign-in. Additive to 0001_init.sql — no existing table is
-- touched. All timestamps are unix milliseconds, matching the rest of the schema.

-- One row per registered authenticator ("passkey"). A user can have several
-- (phone, laptop, security key, ...); any one of them can complete login.
CREATE TABLE passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,        -- base64url-encoded COSE public key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                 -- JSON array, e.g. ["internal","hybrid"]
  device_type TEXT,                -- 'singleDevice' | 'multiDevice' (credentialDeviceType)
  backed_up INTEGER NOT NULL DEFAULT 0,
  label TEXT,                      -- friendly name for the passkey list, guessed from User-Agent at registration
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_passkey_credentials_user ON passkey_credentials(user_id);

-- Short-lived WebAuthn challenges. A ceremony (register or login) writes one
-- row in the *-options step and consumes (marks used, checks expiry) it in
-- the *-verify step; the client round-trips the opaque `id` between the two.
-- Mirrors how magic_links tracks one-time, expiring tokens.
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,           -- 'register' | 'login'
  user_id TEXT,                    -- set for 'register' (attaching to a signed-in user); NULL for 'login'
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
