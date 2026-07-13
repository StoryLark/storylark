# Getting Started

Get the StoryLark engine running locally under the neutral **StoryLark base
brand**, then build a production bundle. This is the fastest path to seeing the
app boot; standing up your own branded site is covered in
[`deploy-your-own.md`](deploy-your-own.md).

## Prerequisites

- **Node.js 20+**
- A **Cloudflare account** — `npm run dev` runs `wrangler dev`, which needs an
  authenticated Wrangler (`npx wrangler login`) even for local development.
- **ffmpeg / ffprobe** on your `PATH` — only needed to *publish audio* (the TTS
  stitch step). Not required just to run or build the app.

## Clone and install

```
git clone <your-fork-or-clone-url> storylark
cd storylark
npm install
```

This is an npm **workspaces** repo. A single `npm install` at the root installs
the `app`, `worker`, and `tools` workspaces together.

## The commands (from the root `package.json`)

| Command | What it runs | Notes |
|---|---|---|
| `npm run dev` | `npm run build -w app -- --mode storylark && wrangler dev --env storylark` | Builds the PWA for the `storylark` brand, then serves it (static assets + `/api/*`) through the Worker on a local port. |
| `npm run build` | `npm run build -w app -- --mode storylark` | Production build of the app into `app/dist`. |
| `npm run deploy` | `npm run build && wrangler deploy --env storylark` | Build, then deploy the Worker + assets to Cloudflare. See [`deploy-your-own.md`](deploy-your-own.md). |
| `npm run publish` | `node tools/publish.mjs --brand storylark` | Publish content to R2. **This script needs extra flags** — see the note below and [`content-pipeline.md`](content-pipeline.md). |
| `npm run typecheck` | `tsc -p app/tsconfig.json --noEmit && tsc -p worker/tsconfig.json --noEmit` | Type-checks the app and the Worker. |

> **Note on `npm run publish`:** the root script passes only `--brand storylark`,
> but `tools/publish.mjs` *requires* `--source <path>` and `--parser <module>` as
> well and will exit with a usage message otherwise. Treat the npm script as a
> shorthand and pass the remaining flags after `--`, e.g.
> `npm run publish -- --source examples/demo --parser examples/demo/parser.mjs --no-audio --local app/dist`.
> Full details in [`content-pipeline.md`](content-pipeline.md).

After `npm run dev`, open the URL Wrangler prints. The app boots as a branded but
**empty shelf** — there is no bundled content. To see stories, publish some
(the bundled `examples/demo` public-domain stories are the quickest way; see
[`content-pipeline.md`](content-pipeline.md)).

## How the brand "mode" works

The Vite build **mode is the brand id**. `app/vite.config.ts` reads
`--mode <brandId>`, loads `brands/<brandId>/brand.json` + `brands/<brandId>/theme.css`,
and bakes them into the bundle:

- `brand.json` is injected as the `__BRAND__` define and read at runtime through
  `app/src/brand.ts` (`BRAND`, `NOUNS`, `contentUrl()`).
- `theme.css` is served as the virtual module `virtual:brand-theme.css`
  (imported in `app/src/main.tsx`).
- `manifest.webmanifest` and the brand icons are generated / copied into
  `app/dist` at build time.

The built-in Vite modes (`development`, `production`, `test`) fall back to the
`storylark` brand. Any other `--mode` value is treated as a brand id, so
`--mode acme` builds `brands/acme/`. The root scripts all pin `--mode storylark`.

## Project layout

```
brands/     per-brand config: brand.json, theme.css, assets/icons/ (and optional assets/covers/)
app/        Vite + Preact PWA — library / reader / player / settings + service worker
worker/     Cloudflare Worker: Hono API (/api/*) over D1, plus static-asset serving; SQL migrations
tools/      publish pipeline (markdown -> chapter JSON + TTS audio + word timings -> R2) + generators
docs/       these docs
examples/   demo content + a sample parser (public-domain stories) for trying the pipeline
```

Inside `app/src/`:

- `screens/` — Home, Library, Book, Reader, NowPlaying, Settings, About
- `reader/` — read-along engine (AudioController, Highlighter, BlockRenderer, SpeechFallback)
- `lib/` — API client, IndexedDB, downloads, sync, push, player state
- `router.ts`, `brand.ts`, `sw.ts` — routing, baked-in brand, service worker

## Next steps

- Stand up your own site → [`deploy-your-own.md`](deploy-your-own.md)
- Restyle it → [`build-your-own-theme.md`](build-your-own-theme.md)
- Publish stories → [`content-pipeline.md`](content-pipeline.md)
- Understand the internals → [`architecture.md`](architecture.md)
