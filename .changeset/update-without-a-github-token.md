---
'storylark-worker': minor
'storylark-core': minor
---

Platform updates no longer need a GitHub token, or any stored credential
(AB#7403).

A deployed reading app has no business holding a credential that can deploy on
its owner's behalf. The "Install update" button and its
`POST /api/admin/update-install` route — which dispatched a `self-update.yml`
GitHub Actions workflow and therefore required `GITHUB_REPO` +
`GITHUB_DEPLOY_TOKEN` on the deployment — are removed, along with the workflow
template.

What replaces them:

- **Detect** (unchanged): the daily check and `GET /api/admin/update-status`
  still compare the running engine version against the public npm registry,
  unauthenticated and read-only.
- **Update**: `node platforms/<platform>/install.mjs --update --yes`, run by
  the operator from the machine they deploy from. It bumps the pinned engine
  version, installs, migrates, rebuilds with the brand untouched, and
  redeploys — authenticating with the operator's existing `wrangler login` /
  `az login`. It provisions nothing, edits no config, and stores no secret, so
  it is safe to re-run at any time.

`GET /api/admin/update-status` drops `selfUpdateConfigured` and gains
`platform` (detected from the runtime), `updateCommand` (the exact command to
run), and `updateDocsUrl`. The admin portal's Platform update card now shows
that command, with a copy button, instead of an install button.

`GITHUB_REPO` / `GITHUB_DEPLOY_TOKEN` remain optional and are now used by the
admin portal's story upload only.
