<!-- Curated, human-facing release notes — rendered on the in-app About screen and on
     storylark.org. Update by hand each release; keep the format to ## version headings,
     short paragraphs, and - bullets only (HTML comments are not rendered). This is
     separate from CHANGELOG.md, which Changesets owns and auto-generates.
     Headings MUST be storylark-core npm versions — that is the version the app shows
     on screen (About → Version & build), so every entry here names a real release.

     Ownership (AB#7396): THIS FILE is the one source of truth for human-readable
     release notes. Per-package CHANGELOG.md files stay Changesets-owned (mechanical,
     per-package, never hand-edited here or copied from here). storylark-org's
     src/docs/changelog.md is a GENERATED copy of this file, kept in sync by
     .github/workflows/sync-release-notes.yml on every push to main that touches this
     file — never hand-edit changelog.md in storylark-org; edit this file instead. -->

# Release notes

## 0.19.2 (preview)

Clearer Admin language for every kind of library.

- **Stories & Books** is now the permanent name of the Admin content section, whether a
  deployment contains standalone stories, multi-chapter books, or both
- The brand screen now labels its list **Theme version history** and prefixes each entry with
  **Theme:**, so a theme package version cannot be mistaken for the StoryLark engine version

## 0.19.1 (preview)

A safer default installer and lossless adoption for existing libraries.

- **`npm create storylark` is the supported publisher path** — it installs and locks compatible
  engine, Worker, and pipeline packages; records project provenance; and includes `npm run
  doctor` checks for local and live configuration. Cloning the engine remains the advanced path
  for contributors and forks, and a clone is not installed until `npm install` completes
- **Existing Cloudflare resources can be adopted safely** without renaming them or changing the
  deployment's brand identity
- **Repo adoption is matching-only and atomic** — StoryLark compares the complete chapter set,
  rendered content, order, visible metadata, and cover identity before changing ownership.
  Narration, timings, voices, and content objects are preserved; a mismatch writes nothing
- **No-op syncs are truly no-op** — unchanged content keeps its narration and metadata, and a
  second identical sync reports zero writes
- Repository reads now start at the configured path and batch authenticated Markdown requests,
  keeping large private repositories within the Cloudflare Workers Free subrequest budget
- Standalone stories and multi-chapter books are both first-class inputs, including legacy
  single-story chapter ids and root-relative artwork

## 0.19.0 (preview)

Hear a narrator before choosing, and identify every deployed build precisely.

- **Narrator previews** — Settings can play a short sample for each published voice; older
  manifests without samples continue to work unchanged
- **Release build numbers** — the reader About screen and Admin System page now show an overall
  `YYMM.BUILD.PATCH` build number alongside package versions. Admin reports the app bundle and
  Worker independently so a partial deployment is visible

## 0.18.0 (preview)

Bring your own repo, and updates that never ask you to redeploy.

- **Sync your content from a git repo** — connect a GitHub repository under Connections and
  StoryLark keeps a read-only copy: a webhook syncs new commits automatically, a daily pull
  catches anything missed, and Sync now runs it on demand. A chapter missing from the repo is
  flagged, never silently deleted
- **One content gate for every way content arrives** — the admin portal, the public content API,
  and a repo sync all validate the same markdown rules now, so a chapter is either good
  everywhere or rejected everywhere with the same clear error
- **Scoped tokens for the content API** — issue a token that can only push content, see when it
  was last used, and revoke it without touching anyone else's access
- **Per-book layout, automatically** — a single-chapter book now opens straight into its text;
  a multi-chapter book keeps its chapter list, no configuration needed
- **"Update now" works the same on every platform** — a release that only changes the engine
  installs itself in place with an automatic rollback list, no build running anywhere; Cloudflare
  deployments can now set this up from a plain `wrangler login`, with no token to paste by hand
- New Cloudflare deployments no longer need a custom domain or DNS work before content loads

## 0.17.0 (preview)

Pick a look, or pin one for everyone.

- **Reader-choosable themes** — Settings now offers a choice among the gallery's sample themes as
  a visual look, on top of your library's own brand. Switch anytime; light and dark still work
  inside whichever look you pick
- **Force a theme for every reader** — from the admin portal's **Brand & themes** card, pin one
  look for the whole library if you'd rather everyone see the theme you designed. It overrides
  any reader's own choice until you turn it off
- Narration job cards now show real processing time, not just the finished audio's length

## 0.16.0 (preview)

Push content in from your own system, and let a worker handle the narrating.

- **A public content API** (`/api/content/v1`) — a documented, versioned HTTP contract for
  connecting your own CMS or publishing system to StoryLark directly, without going through the
  admin portal or the CLI: push a single chapter, a whole book, or import a zip/batch of many
  books at once for onboarding a whole catalogue in one go
- **A bulk narration queue** — text pushed through the admin portal, the content API, or a bulk
  import is queued for narration and picked up by a worker you run wherever you already publish
  from, with real per-job progress and a time estimate once anything has completed
- **Re-narration is per block, not per chapter** — editing one paragraph re-synthesizes just that
  paragraph; the rest of a chapter's audio is reused unchanged, and costs nothing against a
  metered voice's character budget
- **Reorder chapters from the admin portal**, and a real safety net between it and the CLI: a
  publish or a portal save that would overwrite someone else's more recent edit is refused
  instead of silently applied

## 0.15.0 (preview)

An optional button that installs updates for you.

- **One-click updates, opt-in** — turn it on and `/admin` gets an **Install update** button:
  download a checksum-verified prebuilt engine, apply migrations, and redeploy, with no build
  running anywhere. Off by default, per deployment, and one command turns it back off
- Every release now publishes a build artifact containing the whole engine and none of anyone's
  brand, so the same download is correct for every StoryLark deployment on a given version

## 0.14.0 (preview)

Install a whole look with one file.

- **Theme packages** — a theme now travels as a single `.storylark-theme.zip`. Install one from
  the admin portal's new **Brand & themes** card or from the CLI, with full validation before
  anything changes on your live site, five-version history, and one-click rollback
- The same card lets you edit your brand's own details — name, tagline, colors, fonts — with no
  package involved at all, and download any version you've installed as a package to move it
  somewhere else

## 0.13.0 (preview)

Bring your own source of truth.

- **Sync a library in** from a git repository of markdown, or your own system's small JSON feed,
  instead of publishing by hand. StoryLark keeps a read-only copy and always defers edits to
  wherever the content actually lives
- Every book and chapter now records where it came from, so the CLI, the admin portal, and a
  sync can no longer quietly fight over who owns an edit

## 0.12.0 (preview)

Edit a published story from your phone.

- **The admin portal can now open and edit any already-published chapter** — a plain markdown
  editor with a live preview, upload or download the `.md` directly, insert an image at your
  cursor, and five-version history with one-click revert
- **Corrections vs. publications** — flag an edit as a correction and readers get the fixed text
  without a notification; leave it unflagged for genuinely new writing and it announces as
  before

## 0.11.0 (preview)

Rearrange your app without a rebuild.

- How your library is arranged — the tab bar, Home's sections, library sorting, the reader's
  default mode, and more — is now a file your deployment serves and re-reads on every request,
  the same way your brand already does. Change it and the next page load reflects it, no rebuild

## 0.10.0 (preview)

Your brand goes live the moment you change it.

- **`brand.json` and `theme.css` now ship as real files your deployment reads on every
  request**, not compiled into the JavaScript. Swap either one on a live site and the next page
  load has the new name, colors, or fonts — no rebuild, no redeploy of the app itself
- A curated set of fonts ships with every build, so switching typeface is a one-line edit instead
  of a rebuild

## 0.9.0 (preview)

Three files instead of one.

- **`brand.json` used to carry your identity, your library's shape, and your server addresses
  all in one place.** They're now three separate files — `brand.json` (identity), a
  presentation file (shape), and a deployment file (addresses and keys) — so a brand can move
  between deployments without dragging one install's server addresses along with it.
  `npm run migrate-brand` converts an older single-file brand automatically, and an unmigrated
  one keeps working with a warning

## 0.8.0 (preview)

Real accounts for the people running a site.

- **The admin portal now signs operators in with a normal email and password** instead of a
  shared key typed into the browser. A one-time setup link and ten printed recovery codes at
  deploy time mean you're never locked out with no way back in

## 0.7.0 (preview)

Runs anywhere, updates itself, and you can manage it from your phone.

- **Runs on Azure now, not just Cloudflare** — a database adapter (Postgres,
  also covers AWS) and a storage adapter (Azure Blob) sit behind the same
  interfaces the Cloudflare drivers use, so switching platforms never
  touches your brand or your content
- **The deployed app updates itself** — a new admin portal at `/admin` shows
  you what's running versus the latest release, and one click starts the
  update: your site rebuilds, migrates its database, and redeploys, with
  no other action required from you. Updates never touch your theme or
  presentation
- **A lighter way to publish** — stories are plain markdown now, one folder
  per book, no custom code required to get started. The admin portal can
  also publish a short text story straight from your browser
- **`npm create storylark`** — one command scaffolds a complete branded
  site, and a setup wizard walks you through picking a platform and
  deploying it

## 0.5.0 (preview)

The considerate release: your screen stays on, and your stories stop when you do.

- Read-along now keeps your screen awake — no more mid-chapter dimming while you follow the
  highlighting. A "Keep screen awake" setting (on by default where your browser supports it)
  controls this, and it releases the moment you pause or leave the reader
- Finishing a story no longer auto-plays the next one. If you liked the old behavior, turn on
  "Auto-play the next story" in Settings → Playback — your choice syncs across devices.
  Chapters inside a book still flow continuously either way
- For deployers: updates are now opt-in by design — each new engine release opens a pull
  request in your site repo with these release notes attached; merging it is the approval
  that rebuilds and redeploys your site. Nothing ever updates without your say-so

## 0.4.0 (preview)

Narrator voice picker, and a build identity you can trust.

- Libraries can now publish more than one narrator: a "Narrator" picker appears in Settings whenever a library offers 2+ voices
- Your chosen narrator syncs across devices and stays available offline in your downloads
- The demo at storylark.dev now offers two voices — Heart and George — with exact word-synced timings for both
- New Version & build section on this screen: release version, build commit, and build time — the version shown is the actual storylark-core release, so you can always tell exactly what your device is running
- These release notes are now keyed to that same version number, one entry per release

## 0.3.0 (preview)

The three-layer release: the engine now ships as installable packages.

- The engine, API Worker, and publish pipeline are separate versioned packages — `storylark-core`, `storylark-worker`, `storylark-pipeline`
- A branded site is now just an entry file, a config, and a theme folder; engine updates can never touch a site's theme or presentation
- Brand font families are bundled automatically from the theme config — no code edits to change typefaces
- Exact word-synced narration from the bundled narrator: word timings are force-aligned against the actual audio instead of estimated
- Release automation with Changesets; the gallery, demo, and project sites now link each other

## 0.2.0 (preview)

The free-narrator release.

- A bundled, free narrator: publish word-synced audio on your own machine with 28 open voices — no account, no API key, no usage caps
- Premium cloud voices (Azure) became an optional bring-your-own-key tier
- Sample content: two public-domain stories ship through the pipeline so a fresh install has something to read and hear
- A live demo at storylark.dev, and About-screen links to the project sites

## 0.1.0 (preview)

First public preview of the StoryLark engine. The app builds and runs under a neutral
StoryLark base brand; bring your own stories through the publish pipeline.

- Read, Listen, and Read + Listen modes with word-by-word read-along highlighting, remembered per item
- Audio player with speed control, skip, scrubbing, and lock-screen / media-key controls
- Home screen with a Continue card that resumes exactly where you left off, plus a new-releases carousel
- Library with sorting, cover art, and search
- Offline downloads from the Library (text and audio) with per-item storage management
- Accounts: sign up with email, username, and password, or add a passkey (Face ID, Touch ID, Windows Hello); magic-link and Google sign-in available as building blocks
- Cross-device reading-position sync
- New-content push notifications on installed devices
- Installable PWA with a full offline app shell
- Per-brand theming via a `brand.json` + `theme.css` token contract
- App versioning, About screen, changelog, and roadmap
