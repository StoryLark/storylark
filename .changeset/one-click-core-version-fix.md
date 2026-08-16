---
"storylark-worker": patch
---

Fix `POST /api/admin/update-install`'s default version resolution: it asked
the npm registry for `storylark-worker`'s latest version and used that
number to locate the GitHub release, but the release (and its prebuilt
engine artifact) is tagged by `storylark-core`'s version. The two now
diverge whenever a changeset only bumps the worker (as this repo's own
self-deploy fixes just did) — the admin portal's "Install update" button
always POSTs an empty body, so this was the only path it took, and it
404'd looking for a release that was never going to exist. Found live
against Azure dev while verifying the one-click mechanism end to end.
