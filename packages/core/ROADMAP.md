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
- The three-layer package model: the engine (`@storylark/core` + its Vite preset), API Worker
  (`@storylark/worker`), and content pipeline (`@storylark/pipeline`) are separate, versioned
  packages — a branded site is just an entry file, a config, and a theme folder, and pulling in
  engine updates can never touch its theme or layout
- Exact word-synced narration from the free bundled narrator: timings are force-aligned against
  the actual audio, not estimated
- An open gallery of themes and presentation templates at gallery.storylark.dev, with a
  community submission process
- Demo hardening: version banner, release-tracking redeploys, and links across the StoryLark
  sites

## Now

- Publishing the `@storylark/*` packages to the public npm registry (release automation is in
  place; first publish pending)

## Next

- Full documentation: getting started, deploy your own, build your own theme, build your own
  presentation template, content pipeline, API reference
- Downstream sites consume pinned package versions with opt-in automatic updates (Renovate)

## Later

Feature roadmap, built on the refactored engine — each ships behind a config flag:

- Screen-awake during read-along (Wake Lock)
- "Listen to anything" — paste text, or bring a PDF, URL, or document, with on-device voices
- Multiple narrator voices and languages
- Social sign-in (Apple, Google, Microsoft)
- iOS background audio for driving — a research spike

Also planned: rate-limiting on sign-in and account creation, and preferences (default playback
mode, theme, text size) that follow your account across devices.
