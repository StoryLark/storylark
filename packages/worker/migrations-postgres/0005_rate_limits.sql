-- Postgres dialect — mirrors migrations/0005_rate_limits.sql.
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start BIGINT NOT NULL
);
