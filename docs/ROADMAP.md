# Roadmap

<!-- Rendered on the in-app About screen and on storylark.org. Keep the format to ## headings, short paragraphs, and - bullets only. HTML comments are not rendered. -->

The path to 1.0, milestone by milestone. `0.x` means evolving preview — breaking changes are
still allowed. `1.0.0` means the core API is stable and the milestones below are complete.

## Shipped

- A StoryLark-branded base that builds and boots: read/listen/read+listen modes with word-synced
  read-along, offline downloads, cross-device sync, accounts, and push notifications
- Per-brand theming via a `brand.json` + `theme.css` token contract

## Now

- Sample content: publishing public-domain stories through the pipeline so a fresh install has
  something to read and hear out of the box, not an empty shelf
- A live, running demo deployed and kept current with every release

## Next

- The engine, presentation layer, and content pipeline ship as versioned, independently
  installable packages, so a branded site can pull in engine updates without touching its own
  theme or layout
- Full documentation: getting started, deploy your own, build your own theme, build your own
  presentation template, content pipeline, API reference
- An open gallery of themes and presentation templates, with a community submission process

## Later

Feature roadmap, built on the refactored engine — each ships behind a config flag:

- Screen-awake during read-along (Wake Lock)
- "Listen to anything" — paste text, or bring a PDF, URL, or document, with on-device voices
- Multiple narrator voices and languages
- Social sign-in (Apple, Google, Microsoft)
- iOS background audio for driving — a research spike

Also planned: rate-limiting on sign-in and account creation, and preferences (default playback
mode, theme, text size) that follow your account across devices.
