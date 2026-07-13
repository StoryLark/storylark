# API Reference

All endpoints live under `/api` on the app domain and are served by the Worker (Hono).
Auth = session cookie (`sr_session`, HttpOnly, Secure, SameSite=Lax, 30-day rolling).
All mutating requests must send `X-Requested-With: storylark` (CSRF guard).

## Auth

`{user}` in every response below has the shape `{id, email, username, displayName}`
(`username`/`displayName` are `null` for accounts that never set one).

| Method & path | Auth | Behavior |
|---|---|---|
| `POST /api/auth/register` `{email, username, password}` | — | Primary sign-up path. Validates email format, username (3-20 chars `[a-z0-9_]`, case-insensitive unique), password (>= 8 chars). PBKDF2-SHA256 hash, 100,000 iterations, random salt. `400` on invalid input (`invalid_email`/`invalid_username`/`invalid_password`); `409` on a taken username/email (`username_taken`/`email_taken`); else creates the user (or attaches to an existing passwordless row with that email), session cookie, `201 {user}`. |
| `POST /api/auth/login` `{identifier, password}` | — | Primary sign-in path. `identifier` matches email or username, case-insensitive. Any failure (bad input, unknown identifier, no password set, wrong password) returns the same `401 {error:'invalid_credentials'}` and never reveals which; a dummy PBKDF2 derive normalizes timing on the no-real-hash paths. Success: session cookie, `{ok:true, user}`. |
| `POST /api/auth/magic/request` `{email}` | — | Dormant (no UI entry point). Rate-limited 3 per 15 min per email. Stores SHA-256 of a 32-byte token, emails the link via Resend. Always returns `{ok:true}` (no account enumeration). |
| `GET /api/auth/magic/verify?token=` | — | Dormant. One-time redeem within 15 min → upsert user by email → session cookie → `302 /?auth=ok` (`expired`/`failed` otherwise). |
| `POST /api/auth/code/verify` `{email, code}` | — | Dormant. Verifies the 6-digit code from the same email, in-page (sets the cookie in the calling context). `401 {error:'invalid_code'}` otherwise. |
| `GET /api/auth/google` | — | Dormant (no UI entry point yet). 302 to Google (code flow + PKCE, signed 10-min state). |
| `GET /api/auth/google/callback` | — | Server-side code exchange; verifies `aud` + verified email; links by email; cookie; `302 /?auth=ok`. |
| `POST /api/auth/logout` | cookie | Deletes the session row, clears the cookie. |
| `GET /api/auth/me` | cookie | `{user}` or 401. |

## Auth — passkeys

See `auth.md` for the full ceremony flow. Registration is auth-gated (a passkey
proves device possession, not email ownership, so it only ever attaches to an
already-signed-in account); login is how a session gets created in the first
place, so it's unauthenticated by definition.

| Method & path | Auth | Behavior |
|---|---|---|
| `POST /api/auth/passkey/register-options` | cookie | `{options, challengeId}` — `generateRegistrationOptions()` output for `navigator.credentials.create()`, excluding the user's existing credentials. |
| `POST /api/auth/passkey/register-verify` `{challengeId, response}` | cookie | Verifies against the stored challenge, inserts into `passkey_credentials`. |
| `POST /api/auth/passkey/login-options` | — | `{options, challengeId}` — no `allowCredentials`, so any discoverable credential for this RP ID shows in the platform picker. |
| `POST /api/auth/passkey/login-verify` `{challengeId, response}` | — | Looks up the credential by `response.id`, verifies, creates a session exactly like `/code/verify` does → `{ok:true, user}`. |
| `GET /api/auth/passkey/list` | cookie | `{passkeys:[{id,label,createdAt,lastUsedAt}]}` for the signed-in user. |
| `DELETE /api/auth/passkey/:credentialId` | cookie | Owner-scoped delete. |

## Progress & bookmarks

| Method & path | Auth | Behavior |
|---|---|---|
| `GET /api/progress` | cookie | All progress rows for the user. |
| `PUT /api/progress/:bookId/:chapterId` | cookie | Body `{mode, charOffset, audioMs, percent, updatedAt}`. **Last-writer-wins** on `updatedAt` (`ON CONFLICT … WHERE excluded.updated_at > progress.updated_at`); returns the winning row so a stale client adopts the newer state. |
| `GET /api/bookmarks?bookId=` | cookie | List (optionally filtered). |
| `POST /api/bookmarks` | cookie | `{bookId, chapterId, blockId, charOffset?, note?}` → `{id}`. |
| `DELETE /api/bookmarks/:id` | cookie | Owner-scoped delete. |

## Push & library

| Method & path | Auth | Behavior |
|---|---|---|
| `POST /api/push/subscribe` | optional cookie | `{endpoint, p256dh, auth}` upsert; anonymous allowed. |
| `POST /api/push/unsubscribe` | optional | Delete by endpoint. |
| `GET /api/library/version` | — | `{version, updatedAt}` from `library_state`. |
| `GET /api/health` | — | `{ok, brand}`. |

## Admin

| Method & path | Auth | Behavior |
|---|---|---|
| `POST /api/admin/publish` | `X-Admin-Key` header | `{version}` → updates `library_state`, fans out **payload-less** VAPID pushes in batches of 50 (`ctx.waitUntil`). 404/410 endpoints deleted; 5 consecutive failures deletes. Called by `tools/publish.mjs` as its final step. |

## Error shape

Errors return `{"error":"<slug>"}` with a fitting status: `unauthorized` 401, `missing_csrf_header` 403, `bad_request` 400, `not_found` 404, `internal` 500.

## What the API does NOT serve

Story content. Chapters, audio, timings, covers, and the manifest come from the
content domain (R2 custom domain) — produced by the publish pipeline in `tools/`.
