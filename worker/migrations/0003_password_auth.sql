-- Simple email + username + password accounts. Additive to 0001_init.sql and
-- 0002_passkey_credentials.sql: no existing table or column is touched.
-- Every pre-existing user (created via magic link, Google, or a passkey-
-- eligible email) keeps NULLs in these four columns and keeps signing in
-- exactly as before; password sign-in is simply a fourth door into the same
-- `users` table, keyed the same way (verified email) plus an optional
-- username handle.
--
-- SQLite's ALTER TABLE ADD COLUMN can't carry a UNIQUE constraint directly
-- (https://sqlite.org/lang_altertable.html), so uniqueness is a separate
-- partial unique index below. The WHERE clause excludes NULL so the many
-- existing passwordless users don't collide with each other on
-- "username IS NULL". COLLATE NOCASE on the column mirrors how `users.email`
-- is already declared, so "KristopherT" and "kristopert" are the same name.
ALTER TABLE users ADD COLUMN username TEXT COLLATE NOCASE;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;
ALTER TABLE users ADD COLUMN password_iterations INTEGER;

CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;
