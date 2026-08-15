-- Postgres dialect — mirrors migrations/0006_user_preferences.sql.
CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  prefs TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
