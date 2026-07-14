# Changelog

<!-- Rendered on the in-app About screen: keep the format to ## version headings, short paragraphs, and - bullets only. HTML comments are not rendered. -->

## 0.3.0 (preview)

The three-layer release: the engine now ships as installable packages.

- The engine, API Worker, and publish pipeline are separate versioned packages — `@storylark/core`, `@storylark/worker`, `@storylark/pipeline`
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
