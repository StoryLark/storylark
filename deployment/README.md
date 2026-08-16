# deployment/

Per-install config: where a deployment lives and how it publishes. One folder
per brand id, matching `brands/<id>/` and `presentation/<id>/`.

```
deployment/<id>/deployment.json   appOrigin, contentOrigin, vapidPublicKey, tts
```

These values are **not** part of a brand. Two deployments of the same brand —
the Cloudflare site and the Azure box, say — differ here and nowhere else, which
is why they are not in `brands/<id>/brand.json` and are never included when a
brand is shared or packaged.

## This file is the fallback, not the live value

Since AB#7414 the running deployment is the source of truth. The platform
serving the app reads its own environment on every request and injects the
result into `index.html`, `admin.html` and `sw.js` as
`self.__STORYLARK_DEPLOYMENT__` — Cloudflare in the Worker
(`storylark-worker/lib/deployment`), Azure in `platforms/azure/server.mjs`.
Change an app setting or a Worker var and the frontend picks it up on the next
request, with **no rebuild and no redeploy of `dist/`**.

| Field | Deployment env var (live) | Build env var (fallback) |
|---|---|---|
| `appOrigin` | `APP_ORIGIN` | `STORYLARK_APP_ORIGIN` |
| `contentOrigin` | `CONTENT_ORIGIN` | `STORYLARK_CONTENT_ORIGIN` |
| `vapidPublicKey` | `VAPID_PUBLIC_KEY` | `STORYLARK_VAPID_PUBLIC_KEY` |
| `tts.voice` / `.rate` / `.outputFormat` / `.voices` | `TTS_VOICE` / `TTS_RATE` / `TTS_OUTPUT_FORMAT` / `TTS_VOICES` | `STORYLARK_TTS_VOICE` / `_RATE` / `_OUTPUT_FORMAT` / `_VOICES` |

Both `*_VOICES` forms are comma-separated. The live column is the same
environment the API already reads, so the frontend and the backend can no
longer disagree about where content lives.

What this file (plus the `STORYLARK_*` build overrides, which is how the
platform installers configure a site they have just provisioned) still governs:
any context with no server to inject — `vite dev`, `vite preview`, plain static
hosting — and each key independently, so an unset `VAPID_PUBLIC_KEY` leaves the
built-in one alone rather than blanking it.

A live value that is not a valid origin (no scheme, or a path attached) is
**ignored with a warning in the platform log**, and the build-time value is used
instead — a typo in an app setting must not take the whole library offline.

## `sync` — when the content lives somewhere else

A deployment whose library is **pulled from an external source of truth** rather
than authored here carries a `sync` block (AB#7422):

```json
"sync": { "kind": "git", "url": "https://github.com/mypress/website.git", "ref": "main", "path": "site" }
```

`kind` is `git` (a repository of markdown) or `feed` (your own system's JSON
feed) — those two and no others. Read by `packages/pipeline/sync.mjs`, which
runs where publishing runs, not inside the deployment. Environment overrides:
`STORYLARK_SYNC_KIND` / `_URL` / `_REF` / `_PATH`.

Content that arrives this way is recorded `origin: "sync"` and is **read-only in
the admin portal** — whoever owns the content owns the edit button. Full details
in [`docs/content-sync.md`](../docs/content-sync.md).

The read-only credential for a private source is `STORYLARK_SYNC_TOKEN` in the
environment, never a key in this file — see below, and note that `sync.mjs`
treats a token found here as a hard error rather than a warning.

## No secrets here

Everything in this folder is public by definition — it reaches the browser, in
the bundle or in the injected script. The VAPID **public** key belongs here; the **private** key,
database URLs, storage connection strings and the admin key are platform
secrets (`platforms/*/install.env`, `.env`, or `wrangler secret`) and must never
be written to these files.

Schema: `packages/contracts/schemas/deployment.schema.json`.
