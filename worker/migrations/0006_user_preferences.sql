-- Synced subset of Settings (defaultMode, readAlong, theme, fontScale,
-- lineHeight — never autoSync/autoDownload, which describe this device, not
-- the account), one row per user, serialized whole as a prefs JSON blob and
-- replaced last-writer-wins on updated_at, the same shape the `progress`
-- table (0001) already uses. See worker/src/routes/preferences.ts and
-- app/src/lib/state.ts (pullPreferences / saveSettings) for the sync.
CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  prefs TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
