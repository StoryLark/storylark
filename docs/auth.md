# Auth

Four ways in, all ending at the same session cookie:

- **Email + username + password** — the primary path, and the only one shown
  on the sign-in screen (Settings → Account). Simple and quick: an email, a
  username, a password, done.
- **Passkeys** — Face ID / Touch ID / Windows Hello. Fully functional, but
  not featured on the sign-in screen anymore. Reachable only from inside
  account settings once signed in ("Add a passkey", optional, quiet).
- **Magic link / 6-digit code** — fully functional at the API level, but
  currently has no UI entry point at all. Kept around as a foundation for a
  future "forgot your password" flow rather than deleted.
- **Google** — server-side OAuth code flow; the sign-in button isn't shown
  yet (tracked separately), but the route works.

Account linking is by **verified email** across all four — signing in a
second way with the same email attaches to the same account rather than
creating a new one.

## Password (email + username + password) — primary

```
app ── POST /api/auth/register {email, username, password} ──► worker
  worker: validate (email format; username 3-20 chars [a-z0-9_], case-
          insensitive; password >= 8 chars) → check username/email not
          already taken → PBKDF2-SHA256 hash (100,000 iterations, random
          16-byte salt, via crypto.subtle) → INSERT (or UPDATE an existing
          passwordless row with the same email) → create session → {user}

app ── POST /api/auth/login {identifier, password} ──► worker
  worker: look up by email OR username (case-insensitive) → re-derive the
          hash with the stored salt/iterations → constant-time compare
        → create session → {user}
        → ANY failure (bad input, unknown identifier, no password set,
          wrong password) returns the same 401 {error:'invalid_credentials'};
          a dummy PBKDF2 derive runs on the "no real hash to check" paths so
          an unknown identifier and a wrong password take about the same
          time (login can't be used to enumerate which accounts exist).
```

Properties: hashing is **PBKDF2-SHA256 via WebCrypto** (`crypto.subtle.deriveBits`),
not a Node-only algorithm like bcrypt/scrypt, matching the same "no Node APIs, no
`nodejs_compat` flag" constraint the passkey implementation already established.
100,000 iterations, a fresh random 16-byte salt per password (`crypto.getRandomValues`),
both stored as hex alongside the iteration count so a future session can raise the
count without breaking existing hashes. The password itself is never logged and never
returned in any response. Registering with an email that already has a
passwordless account (created via magic link, Google, or a bare passkey-eligible
email) attaches the new username/password to that same account rather than
erroring; registering with an email that already has a password returns
`409 {error:'email_taken'}`. Username collisions return `409 {error:'username_taken'}`,
checked both up front and again around the write itself (closing the race window
between two near-simultaneous registrations for the same name).

## Passkeys (optional, from account settings)

WebAuthn via `@simplewebauthn/server` (Workers-compatible, WebCrypto-based —
no Node APIs, no `nodejs_compat` flag needed) and `@simplewebauthn/browser`
on the client. Discoverable credentials only (`residentKey: 'required'`), so
sign-in is usernameless: the platform picker (Face ID / Touch ID / Windows
Hello / a synced passkey) is the only thing the user interacts with.

```
Registration (requires an existing session — see below):
app ── POST /api/auth/passkey/register-options ──► worker
  worker: generateRegistrationOptions(rpID, rpName, userID=user.id, excludeCredentials=<user's existing credentials>)
        → store {challenge, purpose:'register', userId} in webauthn_challenges, 5-min TTL
        → { options, challengeId }
app: startRegistration({ optionsJSON: options })  // navigator.credentials.create(), same user gesture
app ── POST /api/auth/passkey/register-verify {challengeId, response} ──► worker
  worker: consume challenge (must match userId) → verifyRegistrationResponse(expectedOrigin=APP_ORIGIN, expectedRPID)
        → INSERT INTO passkey_credentials

Login (usernameless):
app ── POST /api/auth/passkey/login-options ──► worker
  worker: generateAuthenticationOptions(rpID) — no allowCredentials, so any
          discoverable credential for this rpID shows in the platform picker
        → store {challenge, purpose:'login'} → { options, challengeId }
app: startAuthentication({ optionsJSON: options })  // navigator.credentials.get()
app ── POST /api/auth/passkey/login-verify {challengeId, response} ──► worker
  worker: consume challenge → look up passkey_credentials by response.id
        → verifyAuthenticationResponse() → persist newCounter/last_used_at
        → create session (same createSession() as every other sign-in path) → Set-Cookie
```

Properties: registration only ever attaches to an **already-authenticated** session
(requireAuth-gated), because a passkey ceremony proves device possession, not email
ownership, so a brand-new account always starts via password registration (or, still
reachable at the API level, email code or Google), then optionally adds a passkey
("Add a passkey to this device"). Challenges
are single-use (`used_at`), 5-minute TTL, stored in D1 (`webauthn_challenges`)
rather than a cookie, mirroring how `magic_links` already tracks one-time
tokens. `rpID`/`expectedOrigin` are derived from `c.env.APP_ORIGIN` — the
same per-brand var `auth.ts` already uses for the magic-link URL and the
Google `redirect_uri` — so this stays brand-neutral with zero brand ids in
shared code. `login-verify` carries the `X-Requested-With` CSRF header check
like `/code/verify`; `register-*` gets it for free from `requireAuth()`.

iOS note: passkeys in an installed PWA need iOS 16+ and a direct user gesture
— the app's buttons call `startRegistration`/`startAuthentication` straight
from `onClick`, with no intervening `await` before that call, so the gesture
isn't lost across the options round-trip.

## Magic link (email, dormant, no UI entry point)

```
app ── POST /api/auth/magic/request {email} ──► worker
  worker: rate-limit (3/15min/email) → random 32-byte token → store SHA-256 + 15min expiry
        → Resend email with https://app.<domain>/api/auth/magic/verify?token=<raw>
user taps link (top-level GET, same origin)
  worker: hash → lookup unused+unexpired → mark used → upsert user by email
        → create session → Set-Cookie → 302 /?auth=ok
```

Properties: raw token never stored; one-time; enumeration-safe (always `{ok:true}`);
works when the link opens in the browser while the PWA is installed (sessions are
per browsing context, which mattered more back when this was the primary path).
The Settings screen no longer has a form for this (or for the 6-digit-code variant,
`POST /api/auth/code/verify`) — both endpoints stay live for a future "forgot your
password" flow, callable directly against the API today.

## Google (dormant, no UI entry point yet)

Standard OAuth code flow **with PKCE**, exchange entirely server-side (client secret
is a Worker secret). State is HMAC-signed with a 10-minute expiry and carries the
PKCE verifier. We accept the ID token directly from Google's token endpoint over TLS
(checking `aud` and `email_verified`), no JWKS round-trip needed for that trust path.
The sign-in button is commented out in `Settings.tsx` until the feature ships
(tracked separately); the route itself works today if called directly.

Account linking: every method above keys on **verified email**. Google sign-in with
an email that already has a password/magic-link account attaches to it (one user,
several doors).

## Sessions

- Cookie `sr_session`: HttpOnly, Secure, SameSite=Lax, Path=/, 30 days.
- DB stores only the SHA-256 of the cookie value.
- Rolling refresh when under 15 days remain.
- Logout deletes the row and clears the cookie.

## CSRF

Same-origin app + Lax cookie already blocks cross-site navigation writes; on top of
that every mutating request must carry `X-Requested-With: storylark`, which a
cross-site form can't add. JSON-only bodies close the rest.

## Setup still required per brand

- `RESEND_API_KEY` secret (verify your sending domain in Resend before first use).
- Google OAuth client per brand (redirect `https://app.<domain>/api/auth/google/callback`,
  scopes `openid email profile`) → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets.
- Passkeys need no new secret or external account: `rpID`/`rpName`/`origin` all come
  from vars already set per brand (`APP_ORIGIN`, `APP_NAME`). They do need the
  `0002_passkey_credentials` D1 migration applied (`wrangler d1 migrations apply
  storylark-<brand> --env <brand> --remote`) before first use.
- Password sign-in needs no secret at all (hashing is local, WebCrypto-only) but
  does need the `0003_password_auth` D1 migration applied the same way, per brand,
  before `/api/auth/register` and `/api/auth/login` stop 404/500ing.
Until then: magic-link requests return ok but no mail sends; `/api/auth/google` 500s. Everything else works.
