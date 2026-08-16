-- Postgres dialect — mirrors migrations/0007_admin_accounts.sql.
--
-- is_admin stays INTEGER 0/1 rather than becoming a native BOOLEAN on this
-- side: the Database seam (src/db/types.ts) passes values straight through in
-- both drivers with no boolean marshalling, so one shared shape means route
-- code reads the same value type on D1 and on Postgres.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

CREATE TABLE admin_setup_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX idx_admin_setup_tokens_expires ON admin_setup_tokens(expires_at);

CREATE TABLE admin_recovery_codes (
  code_hash TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  used_at BIGINT
);
