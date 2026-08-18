---
"storylark-core": minor
"storylark-worker": minor
---

Add an overall release build number (`YYMM.BUILD.PATCH`, derived from git history at build time) alongside each package's own semver, shown on both the reader About screen and the admin portal's System page. The admin view shows the app bundle's release and the worker's reported release independently, so a deploy that lands ahead of or behind a release is visible instead of silently confusing (AB#7653).
