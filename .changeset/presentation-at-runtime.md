---
'storylark-core': minor
'storylark-worker': minor
---

How your library is arranged is data your deployment serves, not code it was built from (AB#7416).

Reordering two tabs meant a rebuild of the whole engine on somebody's laptop and
a redeploy, because the tab bar, the Home sections, the shelf's sorting and every
other structural choice were hardcoded in a component or compiled into the
bundle. `presentation.json` now ships as a real file in the built output, and the
platform serving your site reads it on the way out of every request:

```
index.html / admin.html   <script id="storylark-presentation">self.__STORYLARK_PRESENTATION__={…}</script>
sw.js                     the same assignment, as a prelude
```

Replace `dist/presentation.json` on a deployed site and the live site rearranges
— no recompile, no new hashed chunk, and on the Azure Node server not even a
restart.

**The §0b contract, implemented.** `nav` (position, which entries, their order,
their labels), `home.sections`, `library` (default sort, which sorts and
groupings the picker offers, list or grid, search), `reader.defaultMode`,
`player` (skip distance, speed dial), `cover.aspect`, `detail` (which of cover /
author / description / chapter list / length appear), `auth.required`,
`settings` (which controls the Settings screen offers), `download.mode`,
`emptyState` copy, `about.links`, and `features` for everything core ships next.

**Two rules make a template outlive the engine it was written for.** A missing
key takes the core default, *permanently* — `DEFAULT_PRESENTATION` in
`storylark-core/src/presentation.ts` is exhaustive and is the only place a
default exists, so components read the resolved value and never invent a second
one. An unknown key is ignored with a warning, at all three boundaries: the
build, the serve-time injector, and the resolver. A file written for a newer
engine loads on an older one; a file written today keeps working forever.

**Nothing moves for an existing library.** Every default is the behaviour the app
already had, established by reading the component rather than by taste — the same
four tabs in the same order, the same four-entry shelf picker with the same
labels, ±15s, portrait covers, the same empty-state strings. The three knobs that
used to be *derived* from `layout` — the shelf's grouping and search box, and
what auto-download means — are now ordinary keys whose default still follows the
layout exactly, so the coupling the plan called "surprising and undocumented" is
stated rather than implicit, and overridable for the first time.

- **A third global, not a key in either of the other two.** Reshaping
  `__STORYLARK_DEPLOYMENT__` or `__STORYLARK_BRAND__` would break an installed
  PWA mid-update; the three have different sources and different failure modes;
  and folding presentation into the brand would delete the identity/arrangement
  boundary two commits after it was drawn.
- **All-or-nothing between the injected file and the build-time fallback**,
  unlike brand's per-key merge: an injected presentation *is* this deployment's
  presentation, so a key it does not state must fall through to core's default,
  not to the copy of the same file that was on disk at build time.
- **`layout` and `nouns` leave `Brand`.** They are presentation, they have their
  own resolver, and `NOUNS` / `countUnits()` now come from
  `storylark-core/src/presentation.ts`.
- **Staleness closed.** The service worker re-stamps the precached shell with the
  *stated* presentation (never the resolved one — that would bake this engine's
  defaults into a cached document and let a stale default outlive the update that
  changed it), and `presentation.json` is not precached.
- **Everything degrades.** No `presentation.json`, unparseable JSON, one bad
  value, an older `storylark-worker`, or no server at all: the site stays up on
  the build-time fallback and core's defaults. A hand-edited file cannot take a
  library down.
