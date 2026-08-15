# Roadmap

<!-- Rendered on the in-app About screen and on storylark.org. Keep the format to ## headings, short paragraphs, and - bullets only. HTML comments are not rendered. -->

The path to 1.0, milestone by milestone. `0.x` means evolving preview — breaking changes are
still allowed. `1.0.0` means the core API is stable and the milestones below are complete.

## Shipped

- A StoryLark-branded base that builds and boots: read/listen/read+listen modes with word-synced
  read-along, offline downloads, cross-device sync, accounts, and push notifications
- Per-brand theming via a `brand.json` + `theme.css` token contract
- Sample content: public-domain stories published through the pipeline, so a fresh install has
  something to read and hear out of the box
- A bundled, free narrator: the pipeline synthesizes word-synced narration on your own machine
  with 28 open voices — no account, no API key, no per-character billing. Premium cloud voices
  (Azure) remain an optional bring-your-own-key upgrade
- A live demo at storylark.dev, showcasing both voice tiers
- The three-layer package model: the engine (`storylark-core` + its Vite preset), API Worker
  (`storylark-worker`), and content pipeline (`storylark-pipeline`) are separate, versioned
  packages — a branded site is just an entry file, a config, and a theme folder, and pulling in
  engine updates can never touch its theme or layout
- Exact word-synced narration from the free bundled narrator: timings are force-aligned against
  the actual audio, not estimated
- An open gallery of themes and presentation templates at gallery.storylark.dev, with a
  community submission process
- Demo hardening: version banner, release-tracking redeploys, and links across the StoryLark
  sites
- The `storylark-*` packages published to the public npm registry, with automated releases
  on every merge (Changesets)
- The live demo consumes the published packages exactly like any deployer would — proving
  the update model end to end
- **Multiple narrator voices** — a library can publish more than one narrator; a picker in
  Settings switches between them, synced across devices and available offline
- **Screen-awake during read-along** — a wake lock keeps the screen on while narration plays
  with the text on screen, behind a "Keep screen awake" setting (on by default where supported)
- **Your story, your pace** — finishing a standalone story now stops by default; an opt-in
  "Auto-play the next story" setting continues automatically for those who want it
- **Opt-in updates for downstream sites** — a new release opens a pull request in a deployer's
  site repo with the release notes; merging the PR is the approval that rebuilds and redeploys.
  The live demo runs this exact flow
- **Example customer brands in-repo** — `gunner-the-lab` and `hold-fast-press` ship alongside
  the base brand as worked examples of the theme contract
- **Runs on Azure, not just Cloudflare** — a database adapter (Postgres driver, also covers AWS
  RDS/Aurora) and a storage adapter (Azure Blob driver) sit behind the same interfaces the
  Cloudflare D1/R2 drivers use, so the API code is identical either way. A documented Azure
  recipe (App Service + PostgreSQL Flexible Server + Blob Storage, with a Bicep template) sits
  alongside the Cloudflare one
- **The blessed story format** — plain markdown, no custom parser required. One folder per book,
  numbered chapter files, optional `book.json` for metadata; a single `.md` file is shorthand
  for a one-chapter book. Custom parsers remain available for other source shapes
- **`npm create storylark`** — one command scaffolds a complete branded site (entry, config,
  brand folder seeded from the base theme, both platforms' deploy tooling) and can chain
  straight into the setup wizard for a single, seamless install
- **One setup wizard for both platforms** — asks which cloud, collects the values, writes the
  env file, runs that platform's installer. Each installer verifies everything (login state,
  config validity) before creating anything, and only provisions real resources on explicit
  confirmation
- **The deployed solution updates itself** — a Worker or App Service process can't rebuild
  itself, so the real mechanism is the deployment triggering its own CI: an admin-facing
  update card shows the current vs. latest engine version, and clicking Install dispatches the
  site's own `self-update.yml`, which bumps the pinned version, migrates (with a database
  snapshot on the Postgres path), builds, and redeploys. The click is the only way an update
  ever ships — the updater can only touch the pinned engine version, never a brand's theme or
  presentation
- **A lightweight admin portal** (`/admin`) — the update card above, a status view (library
  size, push subscriber count), and a text story-upload form that commits markdown straight to
  the site's repo and publishes through the real, unchanged pipeline (never a second copy of
  its logic). An optional scheduled check can also email the operator proactively when a new
  release exists

## Now

- Rolling out a second narrator voice on the live demo, and closing out the rest of the M7
  feature list below

## Next

- "Listen to anything" — paste text, or bring a PDF, URL, or document, with on-device voices
- On-device voice & language picker for imported content
- Voice previews — hear a short sample sentence of each narrator right in Settings before
  you pick one
- Social sign-in (Apple, Google, Microsoft)
- iOS background audio for driving — a research spike
- A documented AWS recipe (the Postgres + S3-API drivers already make it possible; the
  step-by-step guide and IaC template are the remaining work)
- In-app admin upload for audio-narrated stories (not just text) — the admin portal's story
  form is text-only today; narration still needs either TTS credentials configured on the
  publish workflow or a CLI publish

## Later

Hardening toward 1.0: an automated test suite and CI quality gate, a full device/browser QA
pass, an accessibility audit, rate-limiting across every auth endpoint, complete API
documentation, and a final API-stability review that freezes the config, theme, and manifest
contracts for 1.0.0 — including the database/storage adapter interfaces and the self-update
workflow contract.
