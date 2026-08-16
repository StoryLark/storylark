---
'storylark-core': minor
'storylark-worker': minor
---

Your brand is data your deployment serves, not code it was built from (AB#7415).

Changing a tagline meant a rebuild of the whole engine on somebody's laptop and
a redeploy, because names, colours, the default theme and font choices were
compiled into the JS bundle. They are not any more. `brand.json` and `theme.css`
ship as real files in the built output, and the platform serving your site reads
them on the way out of every request:

```
index.html / admin.html   <script id="storylark-brand">self.__STORYLARK_BRAND__={…}</script>
                          plus <title>, rewritten from the live brand
sw.js                     the same assignment, as a prelude
/theme.css                your stylesheet, with the live font selection appended
/manifest.webmanifest     generated from the live brand
```

**Replace `dist/brand.json` or `dist/theme.css` on a deployed site and the next
request serves the new brand** — no rebuild, no new JavaScript, no hashed asset
touched. On Azure the running process re-reads the file on every request, with
no restart; on Cloudflare, where a Worker has no filesystem, the files live in
the deployed asset bundle and the Worker reads them through its asset binding.
Injection rather than a fetch: the script sits in `<head>` ahead of the app
bundle, so there is no extra round trip and no flash of the previous brand's
name. The service worker re-stamps the brand into the precached app shell, so an
installed PWA cannot keep serving yesterday's identity either.

**Fonts: a curated set, selected by name.** Every build now ships the whole set —
Newsreader, Lora, Cormorant Garamond, Cinzel, Inter, IBM Plex Mono — and `fonts`
in `brand.json` picks which of them `--font-display`/`-headers`/`-body`/`-mono`
resolve to, appended to `theme.css` when it is served. So switching typeface is a
file edit, not a rebuild. A family outside the set is ignored with a warning and
your theme's own `--font-*` value stands; uploading a custom font is a later
phase. Unused families cost nothing over the wire — a browser fetches a font
file only when something renders in it — and fonts are cached on first use
rather than precached, which makes the offline install smaller than before.

**`theme.css` is no longer bundled.** It is `dist/theme.css`, linked from the
document. If your site imported `virtual:storylark-theme.css` anywhere, drop the
import; the virtual module is gone and the stylesheet is served instead.

**Cloudflare sites: `run_worker_first` changes again.** `!/manifest.webmanifest`
is removed — it was `["/*", "!/assets/*", "!/icons/*", "!/manifest.webmanifest"]`
and is now `["/*", "!/assets/*", "!/icons/*"]` — so the manifest is generated
from your live brand instead of served as the file your last build wrote. Update
your `wrangler.jsonc`; `npm create storylark` writes the new form. `/theme.css`
and the manifest now cost a Worker invocation; `/assets/*` and `/icons/*` still
do not.

**Azure sites: update `storylark-worker` too.** The Node entry imports
`storylark-worker/lib/brand`; an older worker package degrades to the brand baked
in at build with a warning at boot rather than failing to start, so the order of
the two updates does not matter, but the brand will not be swappable until both
have landed.

**Two caveats worth knowing before you change a live brand.** An already-installed
PWA can keep its old home-screen name and icon until it is reinstalled — the OS
owns that copy of the manifest, and that is outside any web app's control.
And icon *files* are still files: the manifest follows `brand.json`, but the
pictures change only when you replace `dist/icons/*`. See
`docs/build-your-own-theme.md` for the full list.
