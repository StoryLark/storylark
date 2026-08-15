<!-- Curated, human-facing release notes — rendered on the in-app About screen and on
     storylark.org. Update by hand each release; keep the format to ## version headings,
     short paragraphs, and - bullets only (HTML comments are not rendered). This is
     separate from CHANGELOG.md, which Changesets owns and auto-generates.
     Headings MUST be storylark-core npm versions — that is the version the app shows
     on screen (About → Version & build), so every entry here names a real release. -->

# Release notes

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
- Two example customer brands, Gunner the Lab and Holdfast Press, now ship
  in the repo as worked examples of the theme contract

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
- Two example customer brands — Gunner the Lab and Holdfast Press — now ship in the repo
  alongside the base brand as worked examples of the theme contract

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
