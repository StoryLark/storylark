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

## Later

Hardening toward 1.0: an automated test suite and CI quality gate, a full device/browser QA
pass, an accessibility audit, rate-limiting across every auth endpoint, complete API
documentation, and a final API-stability review that freezes the config, theme, and manifest
contracts for 1.0.0. A `create-storylark` scaffolder (`npm create storylark`) is planned as a
1.1 convenience layer once the contracts are frozen.
