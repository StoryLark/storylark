---
"storylark-worker": patch
---

Add `./migrate-postgres.mjs` to the package's `exports` map. It was
already listed in `files` (so it shipped in the published tarball) but
missing from `exports` — Node's strict exports-map resolution rejects
any subpath not explicitly listed there regardless of `files`, so
`self-deploy.mjs`'s `createRequire(...).resolve('storylark-worker/
migrate-postgres.mjs')` threw `ERR_PACKAGE_PATH_NOT_EXPORTED` and every
real Azure one-click update failed at the migration step with a false
"file is missing" error. `install.mjs`'s own layer-2 update path never
hit this — it joins the path directly instead of asking Node's module
resolver — which is why this went unnoticed until the one-click path
was exercised for real. Adds a regression test.
