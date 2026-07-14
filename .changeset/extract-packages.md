---
"@storylark/core": minor
"@storylark/worker": minor
"@storylark/pipeline": minor
---

First packaged release of the StoryLark engine — the three-layer model ships as
installable packages:

- `@storylark/core` — the read-along PWA engine plus the `defineStorylarkConfig`
  Vite preset. A site is now `index.html` + a 3-line `entry.ts` + a 5-line
  `vite.config.ts` + a brand folder; theme, fonts, and config arrive through
  virtual modules, so `npm update @storylark/core` can never touch a site's
  theme or presentation.
- `@storylark/worker` — the Hono API Worker, importable from a site's worker
  entry, with D1 migrations shipped under `./migrations`.
- `@storylark/pipeline` — the publish pipeline as a site-agnostic CLI
  (`storylark-publish`) with an injected, site-owned content parser; publish
  state lives in the site repo under `.storylark/`.
