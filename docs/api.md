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

## Admin — brand & theme packages

Installing, versioning and rolling back the deployment's look (AB#7417 — a theme
package is `brand.json` + `theme.css` + `icons/` + optionally
`presentation.json`; see [`build-your-own-theme.md`](build-your-own-theme.md)).

Gated by an admin session **or** `X-Admin-Key`, the same two-door rule
`POST /api/admin/publish` uses — the CLI (`npm run import-theme`) is a headless
caller by definition, and it posts to these exact routes so the portal and the
command line cannot diverge. Needs the same writable content store content
editing needs; without one every route answers `501 {"error":"no_content_store"}`.

| Method & path | Behavior |
|---|---|
| `GET /api/admin/themes` | `{storeAvailable, active, builtIn:{id,appName}, versions[], versionLimit, expects:{extension,icons,maxBytes}}`. `active` is `null` when the deployment is wearing the brand its build shipped with. |
| `POST /api/admin/themes/import` | `multipart/form-data` with a `file` part (or a raw `application/zip` body). Validates the whole package, then makes it live. `{ok, version, warnings, active}`. |
| `POST /api/admin/themes/validate` | The same validation, applied to nothing. `{ok, manifest, brand, hasPresentation, icons, warnings}`. |
| `POST /api/admin/themes/versions/:versionId/activate` | One-click rollback. Re-reads that version's stored files, so it restores exactly the bytes that were installed. `404 no_such_version` once one has aged out. |
| `GET /api/admin/themes/versions/:versionId/package` | That version, rebuilt as a downloadable `.storylark-theme.zip` — including a version the portal FORM produced, which never had an archive. |
| `DELETE /api/admin/themes/active` | Stop overriding; wear the build's brand again. The version history is untouched. |
| `PUT /api/admin/themes/brand` | The portal's brand form. A whole `brand.json` body, validated against the schema in **strict** mode, saved as a new version that inherits the live stylesheet, icons and presentation. |

**Rejection is `422 invalid_package`**, not 400: the request is a well-formed
upload of a real file, and what failed is that file's contents against the
contract. The body carries `errors` (every problem, not the first),
`warnings`, and `applied: false` — nothing is ever written for a package that
fails, so a bad import cannot half-apply.

The last five versions are kept (`THEME_VERSIONS` overrides it) and the live one
is never aged out — the same shape and the same number as content's five text
revisions per chapter.

## Admin — narration queue

Bulk narration (AB#7412 — plan §8 item 4). Gated by an admin session **or**
`X-Admin-Key`, the same two-door rule `POST /api/admin/publish` uses: the thing
that drains this queue is a headless worker. Full design, the worker command and
the failure rules: [`narration-queue.md`](narration-queue.md).

**No deployment narrates.** A Cloudflare Worker cannot run the model at all, and
the Node entry ships no TTS dependency — the model lives in
`packages/pipeline`. So these routes track work rather than doing it, and
`GET /api/admin/narration` returns `runtime.canProcessInDeployment` with the
platform's own reason and the command that does.

| Method & path | Behavior |
|---|---|
| `GET /api/admin/narration` | `{available, runtime:{platform,canProcessInDeployment,reason,runCommand,workerAuthConfigured}, counts:{pending,running,done,failed,cancelled}, charsRemaining, charsPerSecond, estimateSeconds, jobs[], batches[]}`. `charsPerSecond`/`estimateSeconds` are measured from the last 25 completed jobs on this deployment, and are `null` until something completes. `available:false` (never a 500) when the database predates migration 0008. |
| `POST /api/admin/narration/enqueue` | `{staleOnly?, bookIds?, chapters?, label?}` → queues chapters whose audio is missing or stale. `staleOnly:false` re-narrates regardless. Idempotent per chapter. |
| `POST /api/admin/narration/claim` | `{worker, max}` → jobs this worker now owns, each carrying `contentKey`/`contentUrl` to read and `audioKey`/`timingsKey` to write. Atomic; several workers can drain one queue. |
| `POST /api/admin/narration/jobs/:id/complete` | `{audio, timings, durationMs, voices?, elapsedMs?, contentHash?}` → writes the manifest entry, clears `audioStale`, records the job. `409 stale_content_hash` if the text moved while it was being narrated — the audio is discarded rather than published against words it does not match. |
| `POST /api/admin/narration/jobs/:id/fail` | `{error}` → records the worker's own message. |
| `POST /api/admin/narration/jobs/:id/retry` | Requeues a failed or cancelled job, keeping the attempt count. `409 not_retryable` otherwise. |
| `DELETE /api/admin/narration/jobs/:id` | Cancels a pending job. `409 not_cancellable` for one already running. |

Narration is never an announcement: a completion moves `libraryVersion` (so
readers re-fetch and hear it) and never `announceVersion`.

## The content API — the public push contract

`/api/content/v1` is **not** part of the portal's surface and does not move with
it. It is the documented, versioned contract an external publishing system
integrates against: [`content-api.md`](content-api.md) is written for a
third-party engineer and is the authoritative reference.

Summary of the differences from `/api/admin/*`:

- **Versioned in the path and in the body.** Every request states an integer
  `contractVersion`; a missing one is `400 contract_version_required`.
- **Key-first auth.** `X-Admin-Key`, with an admin session as the second door.
- **Push ownership.** Content pushed here is `origin: "sync"` with
  `syncSource.kind: "api"` by default, so the portal shows it read-only and names
  the pushing system. `managed: false` opts out.
- **It refuses what a pull connector owns.** A book synced from a git repo or a
  feed answers `409 managed_externally`; the next sync would revert the push.
- **Bulk, with an explicit policy.** `POST /api/content/v1/books` (a batch) and
  `POST /api/content/v1/import` (a zip of the markdown-folder layout) default to
  `best-effort` and answer `207` with a per-item report when part of a batch
  fails. `all-or-nothing` validates everything first and writes nothing on any
  failure.
- **Every push queues narration** for what it wrote, and says how much.

## Error shape

Errors return `{"error":"<slug>"}` with a fitting status: `unauthorized` 401, `missing_csrf_header` 403, `bad_request` 400, `not_found` 404, `internal` 500.

## What the API does NOT serve

Story content. Chapters, audio, timings, covers, and the manifest come from the
content domain (R2 custom domain) — produced by the publish pipeline in `packages/pipeline/`.
