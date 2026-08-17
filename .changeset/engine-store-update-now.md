---
"storylark-worker": minor
"storylark-core": minor
"create-storylark": minor
---

"Update now" works identically on every platform, with zero setup for the
common case (AB#7418).

The one-click update no longer depends on the platform's deploy API for
releases that only change the engine. Instead of redeploying the site, the
worker downloads the prebuilt engine artifact, verifies its published
checksum, applies pending migrations through its own DB seam (D1 or
Postgres), and installs the files into the deployment's OWN ContentStore —
the same storage content editing and theme packages already use — under a
versioned prefix, then flips one `engine/active.json` pointer. The serving
path prefers the installed engine over the build: same code on Cloudflare
(worker `serveAsset`) and Node/Azure (`server.mjs`), no credential, no
platform API, atomic by construction (documents and hashed bundle always
come from the one resolved version; the previous version's assets stay
servable for mid-update clients until history evicts them).

- Worker: new `lib/engine-store.ts` (install / five-version history /
  rollback / clear, brand-owned paths refused at write time as well as at
  validation); `/update-install` picks the mechanism internally — engine
  store when `storylark-worker` is unchanged, the platform deployer when it
  isn't — and `/update-status` reports a single `updateNow` answer plus the
  engine version history; new `POST /engine/versions/:id/activate` and
  `DELETE /engine/active`; the daily update check now also notices
  core-only releases.
- Core: the Platform update card is one button — "Update now" — with the
  active engine version, rollback list, and the copy-paste command kept as
  the always-working floor; `outputs.json` now records `coreVersion` so a
  deployment knows which engine its build serves.
- Cloudflare config: `run_worker_first` is now `["/*"]` (assets must reach
  the Worker so an installed engine can answer them). Unmodified
  deployments pay an in-memory check per asset request, not a storage read.
- Installers: self-update for API-server releases is provisioned as part of
  a normal `--deploy`/`--update` (Azure: managed identity + Website
  Contributor, no stored credential; Cloudflare: a scoped token minted with
  the installing credential where possible, disclosed fallback otherwise;
  OAuth-only logins are told plainly what still works and how to finish).
  `--disable-one-click` is sticky via `SELF_UPDATE=off` in install.env.

The only case the portal still hands back a command: the release changes
the API server AND the deployment has no self-deploy permission (predates
this change, or explicitly disabled).
