---
"storylark-worker": patch
---

Fix the real cause of the 404 diagnosed in the previous patch: Azure's
`server.mjs` sets `ENGINE_RELEASE_REPO` to `process.env.ENGINE_RELEASE_REPO
?? ''` — an empty string when unset, not `undefined`, since Node env vars
don't distinguish "absent" the way a Cloudflare Workers binding does.
`findEngineRelease()` resolved its default repo with `??`, which only
falls back on `null`/`undefined`, so the empty string reached it unchanged
and built `https://github.com//releases/...` — a real 404, but from a
malformed URL, not a missing release. Switched to a truthy check (`||`),
matching how `ENGINE_RELEASE_BASE` was already handled two lines above.
Removes the temporary diagnostic message from the previous patch now that
the cause is confirmed; adds a regression test.
