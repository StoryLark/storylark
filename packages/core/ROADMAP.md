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
- **Five sample themes ship in-repo** — `storylark`, `loveletter`, `nebula`, `weatherglass`, and
  `wireless`, each a real, worked brand + theme + presentation, and each importable as a real
  theme package. (The earlier `gunner-the-lab`/`hold-fast-press` examples were retired in favor
  of these once theme packages made "install a full worked example" a real, one-file action.)
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
- **Update now with rollback** — `/admin` checks npm for releases and installs
  common engine-only updates into the deployment's own storage from a
  checksum-verified artifact, atomically switching versions without touching
  brand, theme, presentation, or content. API-server releases use narrowly
  scoped platform permission provisioned by the installer. Five-version engine
  history and the installer command remain available for rollback and repair
- **A lightweight admin portal** (`/admin`) — the update card above, a status view (library
  size, push subscriber count), and a text story-upload form that commits markdown straight to
  the site's repo and publishes through the real, unchanged pipeline (never a second copy of
  its logic). An optional scheduled check can also email the operator proactively when a new
  release exists
- **Your brand, presentation, and deployment config are three separate files, live at runtime**
  — identity (`brand.json`), library shape and screen arrangement (`presentation.json`), and
  per-install addresses/keys (`deployment.json`). All three are read fresh on every request, not
  baked into the JavaScript bundle, so replacing one changes a live site with no rebuild — and a
  theme can move between deployments without dragging one install's server addresses along with it
- **Theme packages** — a theme travels as a single `.storylark-theme.zip`, installable from the
  admin portal's **Brand & themes** card or the CLI, fully validated before anything changes, with
  five-version history and one-click rollback. The same card edits your brand's own details
  (name, tagline, colors, fonts) with no package at all
- **Accounts for admins, not a shared key** — `/admin` sign-in is a normal email-and-password
  account flagged as an operator, with a one-time setup link and printed recovery codes at
  install time, and three independent ways back in if you're ever locked out
- **Edit a published story from your phone** — the admin portal can open any existing chapter,
  not just upload new ones: a markdown editor with live preview, five-version history with
  one-click revert, inline image uploads, and Up/Down chapter reordering. An edit can be flagged
  as a correction so it updates the text without notifying every reader
- **The publish pipeline and the admin portal can no longer silently clobber each other** — a CLI
  publish checks the live content before uploading anything and refuses on a real conflict; a
  portal save is refused if the chapter moved underneath it. `--pull` reconciles the two
  deliberately when you want to
- **Re-narration is per block, not per chapter** — editing one paragraph re-synthesizes just that
  paragraph; the rest of the chapter's audio is reused unchanged
- **Sync content in from somewhere you already publish** — a git repository of markdown, or your
  own system's small JSON feed — instead of publishing by hand. StoryLark holds a read-only copy
  and always defers to wherever the content actually lives; every book and chapter now records
  its origin so ownership between the CLI, the portal, and a sync never quietly conflicts
- **A public content API** (`/api/content/v1`) — a documented, versioned HTTP contract for pushing
  content from your own CMS or publishing system directly into a deployment: single chapters,
  whole books, or a zip/batch import for onboarding a whole catalogue at once
- **A bulk narration queue** — anything that arrives outside the CLI (a portal edit, an API push,
  a bulk import) is queued for narration and processed by a worker you run wherever you already
  publish from, with real per-job progress and a time estimate measured from this deployment's
  own completed jobs
- **Reader-choosable themes, with an admin override** — Settings offers a reader a choice among
  the sample themes as a visual look, layered on top of your real brand without ever changing its
  identity. An admin can force one look on every reader from the **Brand & themes** card if they'd
  rather everyone see the theme they designed
- **Voice previews** — Settings can play a published sample sentence before a
  reader chooses a narrator
- **Stories & Books in Admin** — one content manager supports standalone
  stories, multi-chapter books, and mixed libraries, with typed-confirmation
  deletion for deployment-owned content
- **Safe publisher installation and adoption** — `npm create storylark` pins all
  compatible packages, records provenance, installs dependencies, and ships
  doctor checks; repo adoption is atomic, matching-only, and preserves existing
  content objects and narration

## Now

- Release-1 hardening: keep the npm installer, Admin update path, content
  ownership, and public documentation aligned across real publisher deployments
- Expand automated regression coverage for standalone stories, multi-chapter
  books, mixed narration, updates, rollback, and zero-loss repository adoption

## Next

- "Listen to anything" — paste text, or bring a PDF, URL, or document, with on-device voices
- On-device voice & language picker for imported content
- Social sign-in (Apple, Google, Microsoft)
- iOS background audio for driving — a research spike
- A documented AWS recipe (the Postgres + S3-API drivers already make it possible; the
  step-by-step guide and IaC template are the remaining work)
- A simpler hosted narration-worker experience for publishers who do not want
  to run the bundled model on a workstation or CI runner

## Later

Hardening toward 1.0: an automated test suite and CI quality gate, a full device/browser QA
pass, an accessibility audit, rate-limiting across every auth endpoint, complete API
documentation, and a final API-stability review that freezes the config, theme, presentation,
deployment, and manifest contracts for 1.0.0 — including the database/storage adapter interfaces
and the update mechanism's own contract.
