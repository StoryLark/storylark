# Getting Started

StoryLark runs on **Cloudflare or Azure** — pick either, or don't pick yet.
Where you end up depends on what you're trying to do:

- **Stand up your own branded site** (the common case) → skip to
  [Deploying your own site](#deploying-your-own-site) below, then
  [`install.md`](install.md) for the full walkthrough.
- **Run the engine locally to hack on StoryLark itself**, no deployment yet →
  see [Running the engine locally](#running-the-engine-locally).

## Deploying your own site

There are two starting points, and two ways to drive each one — four paths,
same result:

| | Manual | Wizard-driven |
|---|---|---|
| **Clone the repo** | `git clone` the engine, fill in an env file yourself, run the platform installer | `git clone`, then `node platforms/wizard.mjs` asks the questions and runs the installer for you |
| **`npm create storylark`** | Scaffolds a standalone site folder, fill in an env file yourself, run the installer | `npm create storylark my-site -- --deploy` — one command, a few prompts, ends at a live URL |

Every path asks you to pick a platform (Cloudflare or Azure) as part of it —
nothing above assumes Cloudflare. Prerequisites differ by platform:

- **Node.js 20+** either way.
- **Cloudflare**: a Cloudflare account, authenticated Wrangler
  (`npx wrangler login`). See [`deploy-your-own.md`](deploy-your-own.md).
- **Azure**: an Azure subscription, authenticated Azure CLI (`az login`). See
  [`deploy-azure.md`](deploy-azure.md).
- **ffmpeg / ffprobe** on your `PATH` — only needed to *publish audio* (the
  TTS stitch step), regardless of platform.

Full detail on all four paths, what each one produces, and what's shared
across every path (your brand folder, CI wiring, self-update) is in
[`install.md`](install.md).

## Running the engine locally

If you just want to see the app boot and poke at the code — no deployment,
no platform account needed beyond what local dev requires — clone the engine
repo directly and run it against the neutral **StoryLark base brand**.

> This path always runs on Cloudflare tooling (`wrangler dev`) regardless of
> which platform you'd eventually deploy to — it's the engine's own local dev
> loop, not a platform choice. Standing up a real site (Cloudflare or Azure)
> is covered above.

### Prerequisites

- **Node.js 20+**
- A **Cloudflare account** — `npm run dev` runs `wrangler dev`, which needs an
  authenticated Wrangler (`npx wrangler login`) even for local development.
- **ffmpeg / ffprobe** on your `PATH` — only needed to *publish audio* (the TTS
  stitch step). Not required just to run or build the app.

### Clone and install

```
git clone <your-fork-or-clone-url> storylark
cd storylark
npm install
```

This is an npm **workspaces** repo. A single `npm install` at the root installs
the `app` site and the `packages/*` (`storylark-core`, `storylark-worker`,
`storylark-pipeline`) workspaces together, linking the site against the local
packages.

### The commands (from the root `package.json`)

| Command | What it runs | Notes |
|---|---|---|
| `npm run dev` | `npm run build -w app -- --mode storylark && wrangler dev --env storylark` | Builds the PWA for the `storylark` brand, then serves it (static assets + `/api/*`) through the Worker on a local port. |
| `npm run build` | `npm run build -w app -- --mode storylark` | Production build of the app into `app/dist`. |
| `npm run deploy` | `npm run build && wrangler deploy --env storylark` | Build, then deploy the Worker + assets to Cloudflare directly (bypasses the installer — see [Deploying your own site](#deploying-your-own-site) for the supported path). |
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

> **Testing secret-gated routes locally (`ADMIN_KEY` etc.):** put them in
> `.dev.vars` (gitignored) and run `wrangler dev --env <brand> --local`. This
> works — re-verified on wrangler 4.107.0 by minting a real admin setup link
> against a local D1 with the key set *only* in `.dev.vars`, and confirming a
> wrong key still 401s. Earlier versions of this doc said `.dev.vars` never
> reached `env` and told you to paste the value into `wrangler.jsonc`'s `vars`
> block instead; that is no longer true, and you should not do it — a secret
> in `wrangler.jsonc` is one `git add` away from being committed.

### How the brand "mode" works

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

### Project layout

```
brands/             per-brand config: brand.json, theme.css, assets/icons/ (and optional assets/covers/)
app/                the base SITE — a thin consumer of storylark-core (index.html, entry.ts, vite.config.ts)
packages/core/      storylark-core — the PWA engine (library / reader / player / settings + service worker)
                    plus the defineStorylarkConfig Vite preset that builds a site from a brand folder
packages/worker/    storylark-worker — Hono API (/api/*) over a database adapter (D1 or Postgres); SQL migrations
packages/pipeline/  storylark-pipeline — publish pipeline (markdown -> chapter JSON + TTS audio + word timings -> storage) + generators
platforms/          per-platform deploy tooling (cloudflare/, azure/) — installers, IaC, the shared wizard
docs/               these docs
examples/           demo content + a sample parser (public-domain stories) for trying the pipeline
```

Inside `packages/core/src/`:

- `screens/` — Home, Library, Book, Reader, NowPlaying, Settings, About
- `reader/` — read-along engine (AudioController, Highlighter, BlockRenderer, SpeechFallback)
- `lib/` — API client, IndexedDB, downloads, sync, push, player state
- `router.ts`, `brand.ts`, `sw.ts`, `mount.tsx` — routing, baked-in brand, service worker, the `mount()` entry

## Next steps

- Stand up your own site → [`install.md`](install.md) (then [`deploy-your-own.md`](deploy-your-own.md) or [`deploy-azure.md`](deploy-azure.md))
- Restyle it → [`build-your-own-theme.md`](build-your-own-theme.md)
- Publish stories → [`publishing-stories.md`](publishing-stories.md)
- Understand the internals → [`architecture.md`](architecture.md)
