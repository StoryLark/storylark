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

The portal's own routes are gated by an **admin session** — a normal account
in `users` with `is_admin = 1`, signed in through the same cookie as any
reader (`requireAdmin()` in `lib/session.ts`). `X-Admin-Key` survives only
where no browser can be involved. See [`admin-guide.md`](admin-guide.md).

| Method & path | Auth | Behavior |
|---|---|---|
| `GET /api/admin/status` | admin session | Brand, engine version, book/chapter counts (from the public manifest), push subscriber count. |
| `GET /api/admin/update-status` | admin session | `{current, latest, hasUpdate, releaseNotesUrl, platform, updateCommand, updateDocsUrl}`. `current` is the deployment's own installed `storylark-worker` version; `latest` is an unauthenticated read of the npm registry. `updateCommand` is the installer command the *operator* runs on their own machine — there is no install endpoint, by design (see [`updating.md`](updating.md)). |
| `POST /api/admin/publish-story` | admin session | Commits `content/books/<id>.md` via the GitHub Contents API, then dispatches `publish.yml`. |
| `POST /api/admin/publish` | `X-Admin-Key` **or** admin session | `{version}` → updates `library_state`, fans out **payload-less** VAPID pushes in batches of 50 (`ctx.waitUntil`). 404/410 endpoints deleted; 5 consecutive failures deletes. Called by `packages/pipeline/publish.mjs` as its final step — headless CI, hence the key door. |
| `POST /api/admin/setup` | `X-Admin-Key` header | One-shot schema bootstrap. Key-gated because it runs before any user can exist. |
| `POST /api/admin/setup/reset` | `X-Admin-Key` header | Mints one setup token + 10 recovery codes, invalidating any outstanding ones → `{setupUrl, expiresAt, recoveryCodes[]}`. The only time the plaintext codes exist. |
| `POST /api/admin/setup/claim` | setup token | `{token, email, username?, password}` → creates/promotes the admin account, burns the token, sets the session cookie. |
| `POST /api/admin/recover` | recovery code | `{email, code, password}` → resets that admin's password, burns the code, sets the session cookie. |

## Admin — content editing

Editing the deployment's own content. Every route is admin-session gated (no
`X-Admin-Key` door — none of this is called headlessly) and needs a writable
content store: the CONTENT R2 binding on Cloudflare, or
`AZURE_STORAGE_CONNECTION_STRING` / `STORYLARK_LOCAL_CONTENT` on the Node entry.
Without one, every route answers `501 {"error":"no_content_store"}` with an
explanation. Design: [`design/admin-content-editing.md`](design/admin-content-editing.md).

| Method & path | Behavior |
|---|---|
| `GET /api/admin/content/books` | The whole library, from `manifest.json` alone — no per-chapter storage reads. `{storeAvailable, contentOrigin, libraryVersion, announceVersion, revisionLimit, books:[{id,title,author,description,cover,chapterCount,origin,readOnly,syncSource?,chapters:[{id,title,label,wordCount,readingTime,hasAudio,audioStale,hasSource,contentHash,publishedAt,origin,readOnly}]}]}`. |
| `GET /api/admin/content/books/:bookId/chapters/:chapterId` | `{bookId,chapterId,title,label,markdown,reconstructed,hasAudio,audioStale,wordCount,readingTime,contentHash,origin,readOnly,syncSource?,revisions[],revisionLimit}`. `reconstructed: true` means the chapter predates source upload and the markdown was rebuilt (lossily) from its published blocks. |
| `PUT /api/admin/content/books/:bookId/chapters/:chapterId` | `{markdown, correction?}` → writes the source, re-parses, writes a new content-hashed chapter JSON, appends a revision, rewrites the manifest, records the publish. `correction` defaults to `true` for an existing chapter and `false` for a new one. Returns `{ok,created,contentHash,wordCount,readingTime,blocks,audioStale,libraryVersion,announceVersion,correction,revision,revisionCount,notified:{version,announced,subscriptions}}`. `400 invalid_markdown` with prose when validation fails — before anything is written. |
| `DELETE /api/admin/content/books/:bookId/chapters/:chapterId` | Removes the manifest entry. The content-hashed objects, the source and the history stay, so this is recoverable. |
| `PUT /api/admin/content/books/:bookId` | `{title?, author?, description?}` → book-level metadata. Never announces. |
| `POST /api/admin/content/preview` | `{markdown}` → `{title,label,blocks,wordCount,charLength,readingTime,problem}`. The editor's live preview, parsed by the same code that publishes rather than by a second markdown implementation in the browser. Writes nothing. |
| `GET /api/admin/content/books/:bookId/chapters/:chapterId/download` | The current markdown as `text/markdown` with a `Content-Disposition` attachment — the mirror of upload. |
| `GET /api/admin/content/books/:bookId/chapters/:chapterId/revisions` | `{revisions:[{id,savedAt,savedBy,bytes,live,correction,revertedFrom?}], revisionLimit}`, newest first. |
| `GET /api/admin/content/books/:bookId/chapters/:chapterId/revisions/:revisionId` | `{revisionId, markdown}`. `404` once a revision has aged out. |
| `POST /api/admin/content/books/:bookId/chapters/:chapterId/revisions/:revisionId/revert` | `{correction?}` (default `true`) → puts that revision's text back **through the ordinary save path**, so it re-parses, re-publishes and appends a NEW revision. History is never rewound. |
| `POST /api/admin/upload` | `multipart/form-data`: `file`, `bookId`, `kind` (`inline` \| `cover`), `alt?`. Validates type (PNG/JPEG/WebP/GIF/AVIF — no SVG) and size (`CONTENT_MAX_UPLOAD_BYTES`, default 8MB), writes through the storage seam under a content-hashed key, and returns `{ok,kind,key,url,bytes,contentType,markdown?}`. For `inline`, `markdown` is the exact `![alt](url)` reference for the editor to insert. For `cover`, the manifest's book entry is updated. |

### Ownership: `origin` and `409 managed_externally`

Every book and chapter records where it came from — `portal`, `cli`, `sync` or
`personal` (see [`content-sync.md`](content-sync.md)). An absent `origin` reads
as `cli`, so a library published before the field existed stays fully editable.

`origin: "sync"` content is **read-only through this API**. It is still listed,
readable, previewable and downloadable — you need to see your whole library —
but every write route (`PUT` chapter, `DELETE` chapter, `PUT` book, revert,
`POST /api/admin/upload`) answers:

```
409 { "error": "managed_externally", "message": "…edit it at source…",
      "origin": "sync", "syncSource": { "kind": "git", "url": "…", "ref": "…" } }
```

409 rather than 403: the credentials are fine, the request conflicts with where
the content lives. The message names the actual source, because "edit at source"
is not advice unless it says which one. The gate runs **before** any other
lookup, so a refusal never masquerades as a 404.

### The correction rule

`correction` splits what used to be one event into the two it always was:

- **`manifest_version` in the database always moves.** It is the freshness probe
  `GET /api/library/version` answers, and the only thing that makes a reader
  re-fetch the manifest. A correction that skipped it would be a correction
  nobody receives.
- **`announceVersion` in the manifest, and the push fan-out, move only for a
  publication.** The app's "new content" badge compares against
  `announceVersion` (falling back to `libraryVersion` on older manifests), so a
  typo fix reaches every reader without badging the library or ringing a phone.

`POST /api/admin/publish` takes the same `announce` flag (default `true`, which
is what the CLI pipeline sends).

## Error shape

Errors return `{"error":"<slug>"}` with a fitting status: `unauthorized` 401, `missing_csrf_header` 403, `bad_request` 400, `not_found` 404, `internal` 500.

## What the API does NOT serve

Story content. Chapters, audio, timings, covers, and the manifest come from the
content domain (R2 custom domain) — produced by the publish pipeline in `packages/pipeline/`.
