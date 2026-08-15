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
the `app` site and the `packages/*` (`storylark-core`, `storylark-worker`,
`storylark-pipeline`) workspaces together, linking the site against the local
packages.

## The commands (from the root `package.json`)

| Command | What it runs | Notes |
|---|---|---|
| `npm run dev` | `npm run build -w app -- --mode storylark && wrangler dev --env storylark` | Builds the PWA for the `storylark` brand, then serves it (static assets + `/api/*`) through the Worker on a local port. |
| `npm run build` | `npm run build -w app -- --mode storylark` | Production build of the app into `app/dist`. |
| `npm run deploy` | `npm run build && wrangler deploy --env storylark` | Build, then deploy the Worker + assets to Cloudflare. See [`deploy-your-own.md`](deploy-your-own.md). |
| `npm run publish` | `node packages/pipeline/publish.mjs --brand storylark` | Publish content to R2. **This script needs extra flags** — see the note below and [`content-pipeline.md`](content-pipeline.md). |
| `npm run typecheck` | `tsc` over the site, core, and worker tsconfigs | Type-checks the site, the engine, and the Worker. |

> **Note on `npm run publish`:** the root script passes only `--brand storylark`,
> but `packages/pipeline/publish.mjs` *requires* `--source <path>` as well and will
> exit with a usage message otherwise. Treat the npm script as a shorthand and pass
> the remaining flags after `--`, e.g.
> `npm run publish -- --source examples/demo --no-audio --local app/dist`.
> Stories are plain markdown — see [`authoring-stories.md`](authoring-stories.md) for
> the format and [`content-pipeline.md`](content-pipeline.md) for the full pipeline
> reference (including `--parser` for non-markdown sources).

After `npm run dev`, open the URL Wrangler prints. The app boots as a branded but
**empty shelf** — there is no bundled content. To see stories, publish some
(the bundled `examples/demo` public-domain stories are the quickest way; see
[`content-pipeline.md`](content-pipeline.md)).

> **Testing secret-gated routes locally (`ADMIN_KEY` etc.):** confirmed on this
> project's Workers+Assets setup, `.dev.vars` / `.dev.vars.<env>` / `--var`
> do not actually reach `env` in `wrangler dev` — the startup banner claims
> the binding exists, but the Worker never sees it (verified by dumping every
> key on `env` at runtime: only what's declared in `wrangler.jsonc`'s `vars`
> shows up). To test an admin route locally, temporarily add the value under
> that env's `vars` block in `wrangler.jsonc` and remove it before
> committing — never commit a real secret this way.

## How the brand "mode" works

The Vite build **mode is the brand id**. The `defineStorylarkConfig` preset
(from `storylark-core/vite`, used by `app/vite.config.ts`) reads
`--mode <brandId>`, loads `brands/<brandId>/brand.json` + `brands/<brandId>/theme.css`,
and bakes them into the bundle:

- `brand.json` is served as the virtual module `virtual:storylark-config` and
  read at runtime through `packages/core/src/brand.ts` (`BRAND`, `NOUNS`,
  `contentUrl()`) — the service worker consumes the same module.
- `theme.css` is served as `virtual:storylark-theme.css`, and the brand's font
  families become `@fontsource` imports via `virtual:storylark-fonts` (both
  imported in `packages/core/src/mount.tsx`).
- `manifest.webmanifest` and the brand icons are generated / copied into
  `app/dist` at build time.

The built-in Vite modes (`development`, `production`, `test`) fall back to the
`storylark` brand. Any other `--mode` value is treated as a brand id, so
`--mode acme` builds `brands/acme/`. The root scripts all pin `--mode storylark`.

## Project layout

```
brands/             per-brand config: brand.json, theme.css, assets/icons/ (and optional assets/covers/)
app/                the base SITE — a thin consumer of storylark-core (index.html, entry.ts, vite.config.ts)
packages/core/      storylark-core — the PWA engine (library / reader / player / settings + service worker)
                    plus the defineStorylarkConfig Vite preset that builds a site from a brand folder
packages/worker/    storylark-worker — Cloudflare Worker: Hono API (/api/*) over D1; SQL migrations
packages/pipeline/  storylark-pipeline — publish pipeline (markdown -> chapter JSON + TTS audio + word timings -> R2) + generators
docs/               these docs
examples/           demo content + a sample parser (public-domain stories) for trying the pipeline
```

Inside `packages/core/src/`:

- `screens/` — Home, Library, Book, Reader, NowPlaying, Settings, About
- `reader/` — read-along engine (AudioController, Highlighter, BlockRenderer, SpeechFallback)
- `lib/` — API client, IndexedDB, downloads, sync, push, player state
- `router.ts`, `brand.ts`, `sw.ts`, `mount.tsx` — routing, baked-in brand, service worker, the `mount()` entry

## Next steps

- Stand up your own site → [`deploy-your-own.md`](deploy-your-own.md)
- Restyle it → [`build-your-own-theme.md`](build-your-own-theme.md)
- Publish stories → [`content-pipeline.md`](content-pipeline.md)
- Understand the internals → [`architecture.md`](architecture.md)
