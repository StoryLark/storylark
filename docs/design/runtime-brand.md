# Design: The brand is data the deployment serves, not code it was built from

A StoryLark site's identity — its names, tagline, author, manifest colours,
default theme and font choices — used to be compiled into the JavaScript
bundle. Changing a tagline meant a rebuild of the whole engine on somebody's
laptop and a redeploy. Now `brand.json` and `theme.css` ship as **files** in the
built output, and the platform serving the site reads them on the way out of
every request.

## Why

Two things depend on it.

**"Click to update, nothing local, ever."** An operator changing their library's
name should not need a checkout, a toolchain, or a build. Replacing one file on
their own deployment is a thing a portal button can do; recompiling an
application is not.

**Swapping the engine.** The plan's end state is a prebuilt engine artefact that
a deployment downloads and swaps in on update. That is impossible while the
customer's brand is *inside* the artefact — you would be shipping them somebody
else's identity. The brand had to come out of the bundle before the bundle can
be shared.

## What "runtime" means here

Not a config service. Cloudflare Workers have no filesystem and no ambient
config store, so the brand travels **with** the deployment — as static assets
next to the code rather than as bundle contents:

| Asset | What it is | Lifetime |
|---|---|---|
| `dist/brand.json` | the live identity | swapped by an operator |
| `dist/theme.css` | the live look | swapped by an operator |
| `dist/fonts.json` | the curated font set this build shipped | changes with the engine |
| `dist/icons/*` | the icon files | swapped by an operator |

"Runtime" is *read fresh from a shipped asset on every request*, not *fetched
from somewhere else*. That distinction is what makes it work identically on a
Worker with no disk and on a Node process with one.

## The mechanism

Deliberately the same one Phase 1 built for deployment config, because it was
already proven and both platforms already route documents through it.

| Response | What the platform does |
|---|---|
| `index.html`, `admin.html` | prepends `<script id="storylark-brand">self.__STORYLARK_BRAND__={…}</script>` to `<head>`, and rewrites `<title>` |
| `sw.js` | the same assignment, as a prelude |
| `/theme.css` | serves `dist/theme.css` with the live font selection appended as `--font-*` declarations |
| `/manifest.webmanifest` | generates it from the live brand |

Injection, not a fetch: the script sits ahead of the module bundle, so the app
reads the live brand during its own module evaluation — no round trip, nothing
to await, and no flash of the previous brand's name.

One shared injector, `packages/worker/src/lib/brand.ts`: the Cloudflare Worker
imports it directly, the Azure Node server as `storylark-worker/lib/brand`.
Identical bytes injected either way; only how each gets hold of the document
differs.

### Two globals, not one

Brand identity is a **second** script tag rather than a key inside Phase 1's
`__STORYLARK_DEPLOYMENT__`. Reshaping that global would break deployments
mid-update: an installed PWA's service worker reads
`__STORYLARK_DEPLOYMENT__.contentOrigin`, and a document injected with a nested
shape would silently take that install's library offline. The two also have
different sources (environment variables vs. a file on the deployment's own
assets) and therefore different failure modes. The plumbing — which URLs reach
the injector — is shared either way, so merging them would have saved nothing.

### Fonts

The genuinely hard part, because a font is binary files, not a string. The set
is fixed at build time and the **selection** is runtime: every curated family's
`@font-face` CSS and files ship with the engine, once, the same for every brand,
and `fonts` in `brand.json` picks which of them the `--font-*` custom properties
resolve to. Changing the pick is a file swap. Adding a family to the set is a
core release. Arbitrary custom-font upload is a later phase.

The declarations are appended to `theme.css` rather than injected as a `<style>`
in the document. A `<style>` in the app shell would be precached with the shell
and go stale on an installed PWA, which would then need re-stamping in the
service worker — a second implementation, in a second package, that has to agree
with the first. Appending to the stylesheet the browser already has to fetch
means one implementation, no extra request, and no unstyled frame.

Source of truth for the set is `packages/core/vite/fonts.mjs`, read by two
places that never meet: the build (which turns it into `@fontsource` imports)
and the server (which reads `dist/fonts.json`, emitted from it by that same
build). The server reads the build *artefact* rather than importing the registry
so that the stacks it serves are always the stacks whose files that build
shipped — a registry duplicated in `storylark-worker` could drift; a build output
cannot.

## Staleness, which is where the sharp edges are

| Copy | How it stays current |
|---|---|
| The document | injected at response time, served `no-store` |
| The precached app shell | the service worker re-stamps the brand into it on every cache hit, the same way it re-stamps deployment config |
| `theme.css` | network-first in the service worker, cached only as the offline floor — never stale-while-revalidate, which would show the old brand for one whole launch |
| `manifest.webmanifest` | generated per request, and excluded from the precache |
| Fonts | cached on first use, immutable and hashed thereafter |
| **An installed app's name and icon** | **not in our control** — see below |

Once a PWA is installed, the *operating system* owns the copy of the manifest it
installed with: the home-screen label and the icon. A current manifest is served
immediately and browsers do re-read it, but whether and when an existing install
picks up a new name is the platform's decision. Assume existing installs keep
the old label until they are removed and re-added. Everything inside the app
updates normally.

## What is still baked, and why

`layout` and `nouns` — the presentation contract — are still compiled in.
Nothing reads them at runtime yet, and making them runtime touches every
component that names a content unit. That is a separate phase. The boundary is
enforced in code, not by convention: `IDENTITY_KEYS` in
`packages/core/src/brand.ts` is a whitelist, so a `layout` smuggled into a live
`brand.json` is dropped with a warning rather than half-applied.

Icon *files* are also still build-time. A manifest is JSON and costs nothing to
generate from current data; an icon is a picture, and swapping one means putting
different bytes at `/icons/icon-192.png` — which needs no code, only a file.

## Fallbacks

Everything degrades to the values compiled in at build:

- no `dist/brand.json` (a site built by an older core) → no injection, baked brand;
- unparseable `brand.json` → warned, baked brand;
- one bad *value* → that key warned and dropped, the rest of the file applied;
- a font family outside the curated set → warned, the theme's own `--font-*` stands;
- a platform running an older `storylark-worker` → warned once at boot, baked brand;
- no server at all (`vite dev`, `vite preview`, static hosting) → baked brand,
  and `dist/theme.css` carries the build's own font block so it still looks right.
