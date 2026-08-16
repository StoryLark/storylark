# Design: The standalone admin page

`/admin` is not a screen in the reader app. It is a **second Vite entry**
with its own HTML document, its own JavaScript bundle, and no share of the
reader's runtime — built from the same repo, shipped by the same deploy, and
identical on every platform.

## Why

The reader app is a PWA: installable, precached, offline-first. An operator
portal wants the opposite of all three. Folding it into the same bundle meant

- every reader downloaded the admin UI whether or not they could ever use it,
- the service worker precached it, so the operator could be looking at a
  *cached* admin page while pushing a platform update — the one moment where
  a stale UI does real damage,
- and the portal inherited reader chrome, reader state, and the reader's
  router by construction.

## How it's built

| Piece | Where |
|---|---|
| Entry module | `packages/core/src/admin-entry.tsx` |
| Screen | `packages/core/src/screens/Admin.tsx` |
| HTML shell + dev route | `adminPagePlugin()` in `packages/core/vite/index.mjs` |
| Second build input | `build.rollupOptions.input.admin` in the same file |

All four live in **core**, not in a site. A downstream site owns no admin
file at all — no `admin.html`, no admin source, nothing to keep in sync — so
`npm update storylark-core` upgrades the portal, markup included, and it
cannot drift per deployment. The HTML shell is *generated* at build time
(`this.emitFile` in `generateBundle`) for the same reason; it points at the
hashed admin chunk and whatever stylesheets that chunk pulls in.

In `vite dev` there is no built output to point at, so the plugin serves
`/admin` from a middleware, running the same shell through Vite's own
`transformIndexHtml` so the dev client and the preact refresh preamble are
injected exactly as they are for `index.html`.

### What the admin bundle may import

The admin entry imports the admin screen, the brand config, the API client,
and the shared **stylesheets**. That's it. No router, no player, no library
or manifest loading, no IndexedDB, and — deliberately — no service worker
registration. CSS is shared because it is inert; code is not.

Two consequences worth knowing:

- The admin page has no client-side router. Its one link into the reader
  (the "Forgot password?" hand-off to `/settings?forgot=1`) is a full
  document load, which is correct: it's a different page.
- Rollup hoists what genuinely *is* common (preact, the API client, the
  brand config, the shared CSS) into a shared chunk both entries import.
  That chunk contains no reader logic — it is only the overlap.

### What keeps it out of the PWA

- `admin.html` carries **no `<link rel="manifest">`**, so the admin page is
  never an install surface, and `noindex, nofollow` keeps it out of search.
- `injectManifest.globIgnores` excludes `admin.html` and `assets/admin-*`,
  so neither the page nor its bundle is in the service worker's precache.

The service worker's scope is still `/` — it has to be, the reader app is at
the root — so once a reader has installed the app the worker technically
*controls* an `/admin` navigation. It never *answers* one: nothing about
admin is precached, and the worker's own `fetch` handler only touches the
content origin, so every request for the admin page goes to the network.
Verified by cutting the network on an installed client: `/` still loads from
precache, `/admin` fails outright.

## How `/admin` is routed, per platform

**Cloudflare** — nothing to configure. With Workers Assets' default
`html_handling` (`auto-trailing-slash`), a request for `/admin` resolves to
the `/admin.html` asset *before* `not_found_handling: "single-page-application"`
ever runs, and `/admin/` and `/admin.html` both 307 to the canonical
`/admin`. Reader routes still hit the SPA fallback exactly as before. Assets
are served without invoking the Worker (`run_worker_first` is `/api/*` only).

**Azure** (`platforms/azure/server.mjs`) — three explicit routes reproduce
that behaviour, registered *before* the static handler and the SPA
catch-all: `/admin` serves `admin.html`, `/admin/` and `/admin.html` 307 to
`/admin`. Without them the catch-all would hand the operator the reader
shell, which is exactly what it used to do. If `admin.html` is missing — a
site still running a build from an older engine, since the Node process
serves assets it didn't build — `/admin` warns once and falls back to the app
shell rather than erroring.

Anything deeper than `/admin` (e.g. `/admin/anything`) falls through to the
reader app on both platforms. The portal has no sub-paths today; if it ever
grows them, both platforms need the same change on the same day, and this is
the section to update.

## Related

- [Admin Guide](../admin-guide.md) — using the portal.
- [Infrastructure](infrastructure.md) — the platform split this rides on.
- [Update Flow](update-flow.md) — why the portal shows a command instead of
  an install button.
