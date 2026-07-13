# Data Model

## D1 (one database per brand) — user state only

| Table | Purpose | Notes |
|---|---|---|
| `users` | id (uuid), email (unique, case-insensitive), display_name, username (unique, case-insensitive, nullable), password_hash/password_salt/password_iterations (nullable) | Created on first successful sign-in via any method. `username`/`password_*` are only set for accounts that registered with a password (`0003_password_auth.sql`); every other account keeps them `NULL` and keeps signing in the way it always did. |
| `oauth_identities` | (provider, provider_user_id) → user_id | Google `sub` linkage; email joins it to an existing magic-link account. |
| `magic_links` | token_hash (SHA-256), email, expires_at, used_at | Raw token never stored; 15-min TTL; one-time (`used_at`). |
| `sessions` | id = SHA-256 of the cookie value, user_id, expires_at | 30-day rolling; refreshed when <15 days remain. Cookie holds the raw value; DB holds only its hash. |
| `passkey_credentials` | credential_id (PK), user_id, public_key (base64url), counter, transports, device_type, backed_up, label, created_at, last_used_at | One row per registered authenticator; a user can have several. `label` is a friendly guess from the User-Agent at registration time, shown in the Settings passkey list. |
| `webauthn_challenges` | id (PK), challenge, purpose ('register'\|'login'), user_id (nullable), expires_at, used_at | Single-use, 5-min TTL. Mirrors `magic_links`' one-time-token shape; the client round-trips `id` between the `-options` and `-verify` calls. |
| `progress` | PK (user_id, book_id, chapter_id); mode, char_offset, audio_ms, percent, updated_at | `updated_at` is the LWW key (client clock). |
| `bookmarks` | id, user, book, chapter, block_id, char_offset, note | Anchored to stable block IDs. |
| `push_subscriptions` | endpoint (PK), p256dh, auth, failed_count | user_id nullable — anonymous subs allowed. |
| `library_state` | single row: manifest_version | Bumped by admin publish; SW compares against it. |

All timestamps are unix **milliseconds**.

## On-device (IndexedDB `storylark`, 4 stores)

| Store | Contents |
|---|---|
| `kv` | settings (typography/theme/read-along), cached manifest, last-seen library version |
| `progress` | mirror of progress rows, key `bookId/chapterId` — works signed-out and offline |
| `outbox` | queued progress writes made while offline / before sign-in; replayed FIFO |
| `downloads` | per-chapter download records (hash, bytes, completedAt) — re-verified against the cache on startup (iOS can evict) |

Plus two Cache Storage caches: `sr-runtime` (network content passing through) and
`sr-downloads` (explicit user downloads; audio served from here with hand-built
Range responses so offline seeking works).

## How sync stays consistent (LWW)

Every save carries `updatedAt` from the writing device. The server only applies a
write if its `updatedAt` is **newer** than what's stored, and always returns the
winning row. Consequences:

- Offline outbox replays are safe in any order and idempotent.
- Two devices racing converge on the most recent read position.
- A device with a slow clock can't clobber newer progress; it adopts the returned row.

The client mirrors the same rule locally (`saveProgress` ignores older writes), so
UI, IndexedDB, and D1 agree without a sync protocol.

## Content data (R2, not a database)

```
manifest.json                              # library catalog, version, ~60s cache
books/<bookId>/
  book.json
  chapters/<id>.<hash8>.json               # blocks: paragraph|scene-break|display-beat|message-block|end-marker
  audio/<id>.<hash8>.mp3                   # 48kHz/96kbps mono, one file per chapter
  timings/<id>.<hash8>.json                # per block: [charStart,charEnd,startMs,endMs] per word
  covers/
```

Hashed filenames = immutable caching; a republished chapter gets a new hash and the
manifest points at it atomically (manifest uploads last). Block IDs are stabilized
across republishes by text-hash matching so bookmarks and positions survive edits.
