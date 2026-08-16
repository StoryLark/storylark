# Design: The presentation contract

How a StoryLark library is **arranged** — which tabs it has and in what order,
which sections are on Home, how the shelf sorts and groups, how items open, what
the skip button does, what shape the covers are, what the empty shelf says — is
data the deployment serves, not code it was built from.

It is the companion to [Runtime Brand](runtime-brand.md): that one made *who a
library is* swappable on a live deployment, this one makes *how it looks and
behaves* swappable the same way.

## The contract

One file, `presentation/<id>/presentation.json`, validated against
[`presentation.schema.json`](../../packages/core/schemas/presentation.schema.json)
and shipped in the build output as `dist/presentation.json`.

```jsonc
{
  "contractVersion": 1,

  // Structure
  "layout": "flat",                    // flat | series
  "nouns": { "unit": "story", "collection": null, … },

  // Navigation
  "nav": {
    "position": "bottom",              // bottom | side
    "items": ["home", "library", "nowPlaying", "settings"],
    "labels": { "library": "Shelf" }   // optional per-item override
  },

  // Home — presence in the list = shown; order = display order
  "home": { "sections": ["continue", "newReleases"] },

  // Library
  "library": {
    "defaultSort": "order",                              // order | title | author | recent | timeframe
    "sortOptions": ["order", "timeframe", "recent"],     // what the picker offers
    "groupBy": "none",                                   // none | collection | group | timeframe
    "groupOptions": ["group"],
    "view": "list",                                      // list | grid
    "showSearch": true
  },

  // Reader and player
  "reader": { "defaultMode": "read" },                   // read | listen | readListen
  "player": { "skipSeconds": 15, "showSpeed": true },

  // The accepted additions
  "cover":   { "aspect": "portrait" },                   // portrait | square
  "detail":  { "showCover": true, "showAuthor": true, "showDescription": true,
               "showChapterList": true, "showLength": true },
  "auth":    { "required": false },
  "settings": { "typography": true, "theme": true, "narrator": true, "autoPlay": true,
                "readAlong": true, "keepAwake": true, "downloads": true, "notifications": true },
  "download": { "mode": "newUnits" },                    // newUnits | everything
  "emptyState": { "library": "No {unitPlural} published yet. Check back soon.", … },
  "about": { "links": [{ "label": "Our site", "href": "https://example.org" }] },

  // Where every NEW core feature lands
  "features": { "personalImports": { "enabled": true, "placement": "library" } }
}
```

**Every key is optional.** The values above are the core defaults, and they are
exactly what the app did before any of it was configurable — so an existing
library that states only `layout` and `nouns` looks and behaves identically.

## The two rules that make it survive core updates

**1. A missing key takes the core default — permanently.** A template written
today keeps working on every future engine, because anything it does not mention
is supplied by core. The complete default set is `DEFAULT_PRESENTATION` in
[`packages/core/src/presentation.ts`](../../packages/core/src/presentation.ts),
and it is the *only* place a default exists: components read
`PRESENTATION.x.y` directly and never `?? somethingElse`, because a
component-level fallback would be a second default that could disagree with the
first.

**2. An unknown key is ignored with a warning.** A template written for a newer
engine loads on an older one without exploding. Enforced at three boundaries —
the build (`readContract` against the schema), the serve boundary
(`readPresentationAsset`, against a hand-edited live file), and the resolver
itself.

Together these are what make "we ship a feature; customer templates keep
working" a structural property rather than a hope. When core adds a feature it
ships with a default placement under `features`; a template that predates the
feature simply does not mention it and gets that default. **No customer is ever
required to edit anything to stay working.**

## How it reaches the browser

The same mechanism as deployment config and brand, and for the same reasons.

| Response | What the platform does |
|---|---|
| `index.html`, `admin.html` | prepends `<script id="storylark-presentation">self.__STORYLARK_PRESENTATION__={…}</script>` to `<head>` |
| `sw.js` | the same assignment, as a prelude |

Injection, not a fetch: the script sits ahead of the module bundle, so the app
reads the live arrangement during its own module evaluation — no round trip,
nothing to await, and no flash of the previous tab order.

One shared injector,
[`packages/worker/src/lib/presentation.ts`](../../packages/worker/src/lib/presentation.ts):
the Cloudflare Worker imports it directly, the Azure Node server as
`storylark-worker/lib/presentation`. The file is re-read on **every** request, so
replacing `dist/presentation.json` on a deployed site rearranges it with no
rebuild, no redeploy and (on Node) no restart.

### A third global, not a key in either of the other two

`__STORYLARK_DEPLOYMENT__`, `__STORYLARK_BRAND__` and
`__STORYLARK_PRESENTATION__` are three separate script tags on purpose:

1. **Reshaping a global breaks mid-update deployments.** An installed PWA's
   service worker reads whatever shape was current when it was cached; a
   document injected with a reshaped global served to an older worker loses the
   value it needs. Additive globals have no such failure mode.
2. **Different sources, different failure modes.** Environment variables, and
   two different files that an operator edits independently and at different
   cadences. A truncated file should not take out two contracts.
3. **The plumbing is shared either way** — which URLs reach the injector is
   decided by routing, not by how many tags it writes.

### Resolution order

```
self.__STORYLARK_PRESENTATION__      what this deployment serves right now
  ↓ (only when nothing injected)
virtual:storylark-presentation       what the build baked in — vite dev,
                                     vite preview, a bare static host
  ↓ (per key, always)
DEFAULT_PRESENTATION                 core's answer for everything unstated
```

The first two layers are **all-or-nothing**, unlike brand's per-key merge: an
injected presentation *is* this deployment's presentation, so a key it does not
state must fall through to core's default rather than to the copy of the same
file that happened to be on disk at build time. Otherwise deleting `nav` from a
live file would silently reinstate the build's `nav` — a third answer, and rule 1
broken by the mechanism meant to honour it.

## Staleness

The precached app shell carries whatever presentation was injected the day it
was cached, and the precache is only refetched when the *build* changes. The
service worker therefore re-stamps the shell on its way out of the cache, using
its own copy — which is current, because the platform re-injects `sw.js` on
every fetch of it and serves it `no-store`.

It re-stamps the **stated** presentation, not the resolved one. Writing the
resolved object into a cached document would bake this engine's defaults into
it, so a later core update with a different default would be overridden by a
stale copy of the old one — rule 1 undone by a cache.

`presentation.json` is not precached, for the same reason `brand.json` is not: a
precache entry is keyed to the build, and these are the files an operator swaps.

## What v1 deliberately does not do

No custom components, no arbitrary screen composition, no new routes. Those are
the level at which core updates *can* break customer templates. Cloning the repo
and editing the components is always possible — the repo is Apache-2.0 — but
that path carries no compatibility promise. The list above does.

## Where the line sits

| Path | What you get | What we promise |
|---|---|---|
| **Supported** — the keys in the schema | nav, home sections, library arrangement, reader/player defaults, cover shape, detail fields, auth posture, settings exposure, download behaviour, empty-state copy, About links | It keeps working across core updates: a missing key takes the default, an unknown key is ignored with a warning |
| **At your own risk** — clone the repo, edit the components | anything | nothing |
