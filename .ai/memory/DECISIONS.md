# Decisions

<!-- Architecture and design decisions WITH their reasoning, so a future session doesn't relitigate a settled choice. -->

## Email + username + password replaces passkeys as primary sign-in (2026-07-11)

Owner feedback on G6 (passkey-first sign-in): too confusing, wanted "dead
simple" account creation, specifically named email + username + password.
This reverses the G6 decision below in one specific way (what's *featured*
on the sign-in screen) while keeping everything G6 built:

- **Nothing was deleted.** Passkey and magic-link/code endpoints, tables,
  and client helpers (`app/src/lib/webauthn.ts`, `PasskeyManager`) are
  untouched and fully functional. Only `Settings.tsx`'s signed-out `SignIn`
  component changed: it now renders a Create account / Sign in toggle
  (password-based) instead of a passkey button + email form. Passkeys are
  still reachable from `PasskeyManager`, which only ever renders inside the
  already-signed-in `SignedIn` branch, so "optional, from account settings
  only" was already true structurally; the only edit there was a copy tweak
  (stopped saying "instead of an email code," since email code is no longer
  what it's being compared against).
- **Hashing: PBKDF2-SHA256 via `crypto.subtle`, 100,000 iterations, 16-byte
  random salt.** Not bcrypt/scrypt/Argon2, none of which are Web Crypto
  standard algorithms; Workers has no `node:crypto` and this repo already
  established (in the G6 passkey work) that it deliberately avoids the
  `nodejs_compat` flag. PBKDF2 is natively supported by Workers'
  `SubtleCrypto` and needs no dependency. 100,000 was the task's explicit
  floor ("at least 100,000") and was used as-is (not raised toward OWASP's
  newer 600,000 recommendation) to keep per-request CPU time predictable on
  a Workers plan; worth revisiting if the account base grows and abuse
  patterns justify the extra cost.
- **`username`/`password_*` columns are all nullable, added via a fourth
  additive migration.** SQLite's `ALTER TABLE ADD COLUMN` cannot carry a
  `UNIQUE` constraint (confirmed against SQLite's own docs), so uniqueness
  is a separate `CREATE UNIQUE INDEX ... WHERE username IS NOT NULL` (the
  `WHERE` clause matters: without it, every pre-existing passwordless user,
  all with `username IS NULL`, would collide with each other on the unique
  index). Column declared `COLLATE NOCASE`, matching how `users.email`
  already declares its own case-insensitivity, so "case-insensitive unique"
  needs no explicit `COLLATE` at query sites, same convention as email.
- **Username is stored as-typed, not lowercased**, unlike email. Uniqueness
  is enforced by the NOCASE collation regardless of stored case, so this is
  purely a display choice: "KristopherT" reads better than a forced-lowercase
  "kristopert" while still colliding correctly with "kristopherT" at
  registration.
- **Login always returns the same 401 + same error slug
  (`invalid_credentials`) for every failure mode** (malformed input, unknown
  identifier, account with no password set, wrong password), exactly matching
  the task's "a single generic message, do not reveal which." A dummy PBKDF2
  derive (`password.ts`'s `dummyVerify`, fixed non-secret salt) runs on every
  path that has no real hash to check against, so an unknown identifier and a
  wrong password take about the same wall-clock time. Registration is the
  opposite on purpose: duplicate email/username get distinct 409 slugs
  (`username_taken`/`email_taken`) with distinct client copy, because
  "is this username taken" is expected, wanted feedback on a sign-up form,
  not an enumeration risk the way login is.
- **Registering an email that already has a passwordless account (magic
  link, Google, or a bare passkey-eligible row) attaches the new
  username/password to that same account** rather than erroring or creating
  a duplicate. Registering an email that already has a password returns
  `409 email_taken`. The pre-check queries (username, then email) are backed
  by a `try/catch` around the actual write that maps a UNIQUE-constraint
  violation back to the right 409, closing the race window between two
  near-simultaneous registrations for the same name that both pass the
  pre-checks.
- **Client error handling: `ApiError` gained a `.slug` field** (best-effort
  `JSON.parse` of the response body's `{error: "<slug>"}`, matching
  `docs/api.md`'s documented error-shape contract exactly, no new
  server-side response shape invented). This lets `Settings.tsx` show
  distinct copy per failure slug for registration while the sign-in form
  deliberately ignores the slug entirely and always shows the same generic
  sentence, mirroring the server-side asymmetry above at the UI layer too.
- **Not built:** rate limiting on `/register` or `/login` (the task didn't
  ask for it, and magic-link's existing 3-per-15-min pattern doesn't have an
  obvious equivalent for password login without also rate-limiting by IP,
  which this repo has no existing mechanism for). Flagged in
  `.ai/state/OPEN_QUESTIONS.md`, not fixed here.

## Passkeys as primary sign-in (2026-07-11, task G6)

- **Library:** `@simplewebauthn/server` (worker) + `@simplewebauthn/browser` (app), v13.x.
  WebCrypto-based, no Node APIs — confirmed via its own dependency tree (only
  `@peculiar/*` / `@levischuck/tiny-cbor` / `@hexagon/base64`, all pure JS) and
  its docs listing Cloudflare Workers as a supported runtime. No `nodejs_compat`
  compatibility flag needed.
- **Challenge storage: D1, not a signed cookie.** A new `webauthn_challenges`
  table (id, challenge, purpose, user_id, expires_at, used_at) mirrors how
  `magic_links` already tracks one-time tokens — single-use, 5-min TTL, deleted
  by expiry semantics (`used_at`). The client round-trips an opaque `challengeId`
  between the `*-options` and `*-verify` calls, held only in memory for the
  duration of one ceremony (never persisted). Chosen over a cookie because the
  codebase already has this exact pattern for `magic_links` and D1 access is
  cheap; a cookie would've meant a second cookie name and no natural
  single-use/expiry bookkeeping.
- **Registration is auth-gated, always.** `register-options`/`register-verify`
  require an existing session (`requireAuth()`). A WebAuthn ceremony proves
  *device possession*, not *email ownership* — the schema requires `users.email`
  NOT NULL UNIQUE, so there is no passkey-only account creation path. A brand
  new user always starts via email code (or Google), then optionally "Add[s] a
  passkey to this device." This matches the task's framing exactly and avoids
  a whole class of account-takeover-via-unclaimed-email concerns.
- **Login is usernameless (discoverable/resident credentials only).**
  `authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }`
  at registration; `login-options` omits `allowCredentials` entirely, so the
  platform picker shows whichever passkeys it holds for this `rpID` with no
  separate email/username step. `authenticatorAttachment` is left unset
  (neither forced to `'platform'` nor excluded) so hardware security keys and
  hybrid/QR-code cross-device flows still work — the task named Face ID/Touch
  ID/Windows Hello as the target UX but never asked to *exclude* other
  authenticators, and leaving it open is the current WebAuthn best practice.
- **`rpID`/`expectedOrigin` derived from `c.env.APP_ORIGIN`,** the same
  per-brand var `auth.ts` already uses for the magic-link URL and the Google
  `redirect_uri` — not from the incoming request's Host/Origin header (the
  task offered either). Chosen for consistency with the one established
  pattern already in this file, at the cost of real end-to-end register/login
  ceremonies only being testable against the deployed custom domain, not a
  bare `wrangler dev` localhost session (WebAuthn requires the ceremony's
  actual origin to equal `expectedOrigin`). Documented as a NOT-runtime-tested
  gap; not a blocker since curl can't drive a real WebAuthn ceremony either way.
- **Passkey list/remove endpoints** (`GET /list`, `DELETE /:credentialId`)
  were added beyond the task's four explicitly named endpoints, to actually
  support the "passkey list with add/remove" UI requirement. Owner-scoped
  delete, same pattern as `bookmarks.delete('/:id')`.

## Root cause: "the account/profile UI still doesn't show" (2026-07-11)

Investigated the existing code (pre-passkey) and found `AccountSection` was
present, unconditional, and structurally correct — it DID render, in both
signed-in and signed-out states, with no JS crash risk in sibling sections. The
real problem was placement and visual weight: it was the **last** of six
`Settings` sections, styled identically (dashed divider, same `<h2>` size) to
low-stakes rows like "Storage & downloads" above it — easy to scroll past on a
phone, with zero visual signal that it's different from the rest. Separately
(not mutually exclusive), `docs/auth.md` already documents that magic-link taps
open a *separate browsing context* on an installed PWA (especially iOS Safari),
so a user who taps the emailed link instead of using the in-app 6-digit code
would sign in inside the browser, not the installed app — the app would never
show a signed-in profile no matter how long they looked at Settings. Fix:
moved `AccountSection` to render FIRST, gave it a distinct raised-card
treatment (`settings-account-card`), and made passkey sign-in (which always
completes in the SAME page context, no email round-trip) the primary path.
