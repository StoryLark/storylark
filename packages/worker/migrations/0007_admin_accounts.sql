-- Database-backed admin accounts (AB#7404). Replaces the single shared
-- ADMIN_KEY header as the way a human gets into /admin: an operator is just a
-- normal row in `users` — same email+password, same session cookie, same
-- password-reset email flow as any reader — with one extra flag. ADMIN_KEY
-- stays, but demoted to a deployment-config credential (see the two tables
-- below), not something a person types into a login box.
--
-- Additive to 0001-0006: no existing table or column is touched. Every
-- existing user keeps is_admin = 0 and behaves exactly as before.
--
-- SQLite has no BOOLEAN type and the Database seam (src/db/types.ts) does no
-- boolean marshalling in either driver, so this mirrors the convention
-- already used by passkey_credentials.backed_up: INTEGER 0/1.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- One-time links that let someone create (or re-create) the admin account.
-- Minted only by POST /api/admin/setup/reset, which is itself gated by the
-- ADMIN_KEY deployment secret — so minting one requires access to the
-- deployment's configuration, which already implies the power to redeploy the
-- whole app. Short-lived (expires_at) and single-use (used_at), hashed at
-- rest exactly like password_resets: the plaintext token exists only in the
-- installer's terminal output.
--
-- Deployment-wide, not per-account: this is the small-operator model, so
-- there is deliberately no user_id here — the token says "whoever holds this
-- may claim admin", and the claimer supplies the email.
CREATE TABLE admin_setup_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_admin_setup_tokens_expires ON admin_setup_tokens(expires_at);

-- Printed-at-install recovery codes: the door that works when the admin
-- password is forgotten AND email delivery isn't configured/reachable. Same
-- hashed-at-rest, single-use shape as the setup tokens, but with no expiry —
-- their whole job is to still work months later, off a piece of paper or a
-- password manager entry. Minting a fresh batch burns every outstanding one.
CREATE TABLE admin_recovery_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
