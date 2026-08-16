---
'storylark-core': minor
'storylark-worker': minor
---

Deployment config comes from the running deployment, not from the last build (AB#7414).

Change `CONTENT_ORIGIN` in your Azure app settings or your Worker vars and the
API picked it up on the next request — but the frontend did not, because
`appOrigin`, `contentOrigin`, `vapidPublicKey` and `tts` were compiled into the
JS bundle. The two halves of one deployment disagreed until somebody rebuilt
and redeployed the site. They no longer can: the platform serving the documents
stamps its own current environment into them on the way out.

```
index.html / admin.html   <script id="storylark-deployment">self.__STORYLARK_DEPLOYMENT__={…}</script>
sw.js                     the same assignment, as a prelude
```

No extra round trip and no flash of a wrongly-configured UI — the script sits in
`<head>`, ahead of the app bundle, so the values are there before the first line
of app code runs. The service worker gets its own copy because it needs the
content origin synchronously inside its fetch handler, and it re-stamps the
precached app shell so an installed PWA cannot keep serving yesterday's origins
either.

`deployment/<id>/deployment.json` and the `STORYLARK_*` build overrides are now
the **fallback**, per key: they are what a build carries for contexts nothing
injects into (`vite dev`, `vite preview`, plain static hosting), and an unset
environment variable leaves the built-in value alone rather than blanking it. A
live value that is not a valid origin is ignored with a warning in the platform
log rather than shipped to readers.

**Cloudflare sites: `run_worker_first` changes.** It was `["/api/*"]`; it is now
`["/*", "!/assets/*", "!/icons/*", "!/manifest.webmanifest"]`, so navigations,
`/admin` and `/sw.js` reach the Worker and can be injected into. The Worker
serves them via `env.ASSETS.fetch()`, so `/admin` → `admin.html`, the `/admin/`
and `/admin.html` 307s, and the SPA fallback all still come from the asset
router unchanged. Hashed assets and icons still cost no Worker invocation.
Update your `wrangler.jsonc` when you update — `npm create storylark` writes the
new form.

**Brand config no longer carries addresses.** `Brand` (`virtual:storylark-config`)
lost `appOrigin`, `contentOrigin`, `vapidPublicKey` and `tts`; they are
`DeploymentConfig`, exported from `storylark-core` as `DEPLOYMENT`. Anything
reading `BRAND.contentOrigin` should read `DEPLOYMENT.contentOrigin`. Identity
and infrastructure are separate objects with separate lifetimes, which is the
point.
