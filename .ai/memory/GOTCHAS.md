# Gotchas

<!-- Non-obvious traps, footguns, and workarounds that would otherwise cost the next session time. -->

## SQLite `ALTER TABLE ADD COLUMN` can't carry `UNIQUE` (2026-07-11)

Tried to write `worker/migrations/0003_password_auth.sql` as
`ALTER TABLE users ADD COLUMN username TEXT UNIQUE` (mirroring how the task
described the column). SQLite rejects a `UNIQUE` (or `PRIMARY KEY`)
constraint on an `ADD COLUMN` outright (see
<https://sqlite.org/lang_altertable.html>, "Restrictions" list). The fix used
everywhere a "unique-ish column added after the fact" is needed: add the
plain column, then a separate `CREATE UNIQUE INDEX ... WHERE <col> IS NOT
NULL`. The `WHERE` clause isn't optional if the column is nullable and
pre-existing rows will have `NULL` in it: SQLite unique indexes treat every
`NULL` as distinct from every other `NULL` in a *plain* unique index, so this
usually doesn't bite you (multiple NULLs are allowed by default) — but the
explicit partial-index `WHERE` was still used here for clarity and to make
the intent ("only real usernames are compared, NULL rows are exempt from the
index at all") unambiguous rather than relying on that easy-to-forget SQLite
default.

## Cloudflare Workers' SubtleCrypto supports PBKDF2 natively (2026-07-11)

No dependency needed for password hashing. `crypto.subtle.importKey('raw',
bytes, {name:'PBKDF2'}, false, ['deriveBits'])` then `crypto.subtle.deriveBits(
{name:'PBKDF2', hash:'SHA-256', salt, iterations}, key, bits)` both work
in the Workers runtime exactly like they do in a browser, no `nodejs_compat`
flag, no `types` change needed beyond what `@cloudflare/workers-types`
already provides. Confirmed by running the actual endpoints against a local
`wrangler dev` (see `.ai/state/HANDOFF.md`'s entry for this session), not
just by typechecking, since a type-level pass alone wouldn't have caught a
runtime-only "this algorithm isn't implemented" failure.

## TypeScript `Uint8Array<ArrayBuffer>` vs `Uint8Array<ArrayBufferLike>` (2026-07-11)

The TypeScript lib types in this toolchain (5.7+) parameterize `Uint8Array` by
its backing buffer. `@simplewebauthn/server`'s `Uint8Array_` type alias
(`ReturnType<Uint8Array['slice']>`) resolves to the `ArrayBuffer`-pinned
variant, but Workers-runtime APIs like `TextEncoder.encode()` and this repo's
own `b64urlDecode()` (in `worker/src/lib/crypto.ts`) are typed to return the
looser `ArrayBufferLike` variant. Passing one where the other is expected
fails to compile (`Type 'Uint8Array<ArrayBufferLike>' is not assignable to
type 'Uint8Array<ArrayBuffer>'`), even though both are actually the same
concrete type at runtime (never a real `SharedArrayBuffer` here). Fix used:
`worker/src/lib/webauthn.ts` exports `freshUint8Array()`, which allocates by
length (`new Uint8Array(bytes.length)` — the one constructor overload TS
resolves unambiguously to `Uint8Array<ArrayBuffer>`) and copies in. Needed at
every boundary between this repo's own byte-producing helpers / Workers APIs
and `@simplewebauthn/server`'s typed inputs (`userID`, and decoding a stored
public key back out for `WebAuthnCredential.publicKey`).

## CI deploys the Worker on every push to main; D1 migrations do NOT run automatically

`.github/workflows/deploy.yml` runs `wrangler deploy --env <brand>` on every
push to `main`, no path filter, no approval gate. D1 migrations only apply via
manual `workflow_dispatch` with `migrate: true`. Practical effect: pushing
worker code that depends on a new migration (e.g. new tables) is *safe* in
that nothing already-working breaks — the new tables just don't exist yet, so
only the brand-new endpoints that touch them start 500ing until someone runs
`wrangler d1 migrations apply storyreader-<brand> --env <brand> --remote`
(see `docs/deploy.md`). Still, this repo's hard rule is no production push
without explicit user confirmation, and this auto-deploy-on-push wiring is
exactly why: a plain `git push` to `main` IS a production deploy here, not a
separate step. (First noticed and reasoned through in the 2026-07-11 em-dash
copy-pass session; recorded here so it doesn't need rediscovering.)

## Real end-to-end WebAuthn ceremonies can't be curl-tested, and `wrangler dev` origin won't match production

`verifyRegistrationResponse`/`verifyAuthenticationResponse` require the
ceremony's actual browser-reported origin to equal `expectedOrigin` exactly.
Since this repo derives `expectedOrigin`/`rpID` from `c.env.APP_ORIGIN` (the
brand's real `https://app.<domain>` value, for consistency with how
`auth.ts` already builds the magic-link URL and Google `redirect_uri`), a
manual browser test against `wrangler dev`'s local origin (`localhost:8787`
or similar) will fail origin verification even with a real authenticator.
There's also no way to *drive* `navigator.credentials.create()/get()` from
curl or any non-browser tool — the options endpoints can be shape-checked
that way, but the verify endpoints cannot be meaningfully exercised without
a real browser + platform authenticator against the actual deployed custom
domain.
