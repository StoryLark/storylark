-- Fixed-window rate limiting, shared by every throttled auth endpoint. One
-- row per bucket (the caller picks the key, e.g. "login:<ip>"); a bucket's
-- window resets itself the first time it's touched after window_start is
-- more than windowMs in the past, so there is nothing to prune or expire out
-- of band. See worker/src/lib/ratelimit.ts for the read-then-upsert logic
-- this table backs.
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
