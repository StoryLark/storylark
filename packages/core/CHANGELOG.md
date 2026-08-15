# Changelog

## 0.5.0

### Minor Changes

- [`8fed3b9`](https://github.com/StoryLark/storylark/commit/8fed3b9f86ad4dff03a9e7132ff11deab53c0a0d) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Read-along now holds a screen wake lock while narration is playing with the
  text on screen, controlled by a new "Keep screen awake" setting (on by
  default, shown only where the browser supports it, account-synced).
  Finishing a standalone story no longer auto-plays the next story by default:
  a new "Auto-play the next story" toggle in Settings → Playback (flat-library
  brands) makes continuing an explicit, account-synced choice. Chapters within
  a book always continue automatically.

## 0.4.0

### Minor Changes

- [`95e38e0`](https://github.com/StoryLark/storylark/commit/95e38e00711cb3ffb8f86dad44777c1426d34e16) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Traceable build identity. The app version shown in Settings/About is now storylark-core's real npm version (the hand-bumped APP_VERSION counter is gone), and About gains a "Version & build" section listing the version of every installed storylark-\* package plus the solution build's git commit, build time, and brand. The Vite preset injects this at build time via `virtual:storylark-build`. RELEASE-NOTES.md headings are now keyed to the same version number. worker/pipeline: expose `./package.json` in exports so build tooling can read their versions.

### Patch Changes

- [`60beb5f`](https://github.com/StoryLark/storylark/commit/60beb5fa54f86921ef6ac883aa8dad34d3b86fac) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Split the human-facing changelog from the Changesets-managed one: `CHANGELOG.md` is now
  Changesets' own file (auto-generated, don't hand-edit); curated release notes for the About
  screen and storylark.org now live in `RELEASE-NOTES.md`. App version bumped to 0.4.0 for the
  narrator voice picker; roadmap updated to reflect shipped npm packages and the voice picker,
  and to list the remaining M7 features and 1.0 hardening work.

<!-- Owned by Changesets — do not hand-edit. Human-facing release notes live in
     RELEASE-NOTES.md (imported by the About screen). -->

## 0.3.0

### Minor Changes

- [`20d2df7`](https://github.com/StoryLark/storylark/commit/20d2df751b4c4c458aa766731fe0a630fbe8dc26) Thanks [@kristopherjturner](https://github.com/kristopherjturner)! - Narrator voice picker — a library can now offer multiple narrator voices.

  - Pipeline: `brand.json` `tts.voices` lists every voice the library ships;
    extras publish as per-voice audio + word-timing tracks (with automatic
    backfill for already-published chapters), and the manifest carries a
    `voices` map of display names.
  - App: a "Narrator" picker appears in Settings whenever the library publishes
    2+ voices; the choice is synced across devices, applies on the next play,
    and downloads keep the chosen narrator available offline. Older manifests
    without voices keep working unchanged.
