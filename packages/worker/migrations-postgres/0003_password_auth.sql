-- Postgres dialect — mirrors migrations/0003_password_auth.sql. Unlike
-- SQLite, Postgres ALTER TABLE ADD COLUMN can carry the column type directly;
-- CITEXT again gives case-insensitive username comparisons for free.
ALTER TABLE users ADD COLUMN username CITEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;
ALTER TABLE users ADD COLUMN password_iterations INTEGER;

CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;
