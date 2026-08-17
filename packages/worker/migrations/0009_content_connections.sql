-- Content connections (AB#7420 — content-management rework wave 2).
--
-- Two pieces of operational state the repo-sync and Connections work need a
-- HOME for, and the database is the only store both platforms share that is
-- (a) writable at runtime from the portal and (b) never served publicly:
--
--   content_sync        one row: the deployment's content-source configuration
--                       (design §4), the webhook signing secret (§6.2), the
--                       running-sync claim that collapses concurrent runs, and
--                       the last sync report the portal shows. The repo READ
--                       token normally lives as a platform secret
--                       (CONTENT_SYNC_TOKEN — wrangler secret / App Service
--                       setting, exactly like sync.mjs's STORYLARK_SYNC_TOKEN);
--                       the repo_token column is the fallback for a token
--                       entered in the portal form, following the precedent
--                       self_update_oauth set for runtime-held credentials.
--                       The env secret always wins when both exist, and the
--                       value is never echoed back by any route. It is NEVER
--                       in deployment.json — that stays a hard error.
--
--   content_api_tokens  named, individually revocable content-API-only tokens
--                       (design §7 / build step 10), so a third-party CMS is
--                       never handed ADMIN_KEY — the key that also mints admin
--                       setup links. Only the SHA-256 of a token is stored; the
--                       plaintext is shown once at creation and never again.
--
-- Additive to 0001-0008: no existing table or column is touched.

CREATE TABLE content_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- JSON: { "mode": "portal"|"repo"|"api", "repo": { provider, url, visibility,
  -- branch, path, intervalHours } }. Non-secret by construction — the token has
  -- its own column and its own rules.
  config TEXT,
  repo_token TEXT,
  webhook_secret TEXT,
  -- The concurrent-run collapse (design §6.2: "pressing it during a sync
  -- attaches to the running one"): a conditional UPDATE claims this, and a
  -- claim older than the stale window is taken over rather than waited on.
  running_since INTEGER,
  last_sync_at INTEGER,
  -- JSON sync report: written/withheld/errors/missing, exactly what the
  -- portal's sync report renders.
  last_sync TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE content_api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_used_at INTEGER,
  revoked_at INTEGER
);

-- The auth lookup: one indexed read per keyed request.
CREATE UNIQUE INDEX idx_content_api_tokens_hash ON content_api_tokens(token_hash);
