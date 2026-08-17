---
"storylark-worker": minor
"storylark-core": minor
"create-storylark": minor
---

"Update now" now provisions itself on Cloudflare from a plain `wrangler login`
— the last authentication state that used to end with a printed manual step
(AB#7418).

The installer reads the OAuth credentials wrangler itself persists (the
plaintext TOML, or the opt-in keyring-encrypted envelope — formats verified
against wrangler 4.107's shipped source), tries to mint a narrow
`Workers Scripts | Edit` API token from the session (attempted first, though
Cloudflare's wrangler scopes are expected to refuse it), and otherwise hands
the session to the deployment: one refresh takes ownership of its rotation
chain, and the refresh token lands as the `CF_OAUTH_REFRESH_TOKEN` Worker
secret. The worker's self-deploy path exchanges it for a short-lived access
token at the moment of use and persists any rotation in the deployment's own
database (`self_update_oauth` — the secret is the chain's seed, the row its
current state, with race-loss recovery and re-provisioning detection). An
installer that finds nothing to provision from now fails loudly with a
non-zero exit instead of completing a deploy that cannot self-update;
`--disable-one-click` stays a sticky opt-out and now also withdraws (and
best-effort revokes) a handed-over session; `--enable-one-click` runs the
automatic provisioning first and only falls back to pasting a token with
`--manual`.

The portal's update card no longer presents the installer command as anyone's
path: "Update now" is always the answer, the command is folded away as
reference documentation, and a deployment with no self-deploy permission (one
predating automatic setup, or an explicit opt-out) is reported as the fault
state it is — with the repair (run a normal `--update`) — never as a routine
platform difference.
