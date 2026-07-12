# StoryReader — Product Requirements

The single authoritative list, as stated by the author (last updated 2026-07-07).

## Product & brands
- Free installable PWA — no app store, works in any browser, installable on phone/tablet/desktop.
- One codebase, two branded deployments:
  - **Holdfast Press** → app.holdfastpress.com (The Keepers and future series)
  - **Gunner the Lab** → app.gunnerthelab.com (42 stories, 8 eras)
- Marketing pages stay on the main sites (holdfastpress.com/app, gunnerthelab.com/app) and link to the apps; the apps live only on the app subdomains.
- Cost mandate: free/cheap — Cloudflare free tier (Workers, D1, R2); Azure (thisismydemo) only for TTS generation.
- Preview disclaimer banner on the landing page, both brands, while the app is in development.

## Screens & navigation (UI v2)
- **Landing/Home page** (start screen):
  - "Continue" card — last played/read item, resumes where the user left off.
  - "New" section — newly added stories (Gunner) or chapters (Holdfast).
  - Preview banner (above). Polished, brand-aware design.
- **Persistent easy navigation** between all four screens: Home ↔ Library ↔ Now Playing ↔ Settings (bottom tab bar).
- **Now Playing screen** — dedicated player: artwork/title, scrubber, play/pause, ±15s skip, speed, chapter/story picker.
- **Library — Gunner**: flat list of all stories; **searchable and sortable** (title, newest, era order).
- **Library — Holdfast**: hierarchical like Audible — **series → book → chapters**; book view shows overall progress with a prominent Resume/Start, then per-chapter entries with their own progress.
- **Reader screen** — clean distraction-free text, chapter navigation, adjustable type, bookmarks.

## Consumption modes
- The user explicitly chooses one of **three modes per item** (plus a default in Settings):
  1. **Listen** — audio only, Now Playing experience.
  2. **Read** — text only.
  3. **Read + Listen** — text with word-by-word highlighting synced to narration.
- Word-sync accuracy ±150 ms; tap a word to seek.
- Media Session integration — lock-screen/notification controls.
- Web Speech synthesis fallback when narration audio isn't available.

## Accounts & sync
- Sign-in: **magic-link email** (Resend) at launch; **Google and Apple sign-in on the roadmap** (deferred by author 2026-07-06).
- Reading/listening position, bookmarks, and progress sync across devices (last-write-wins; offline outbox replays when back online).

## Offline & downloads
- Download for offline: text and audio, playable offline **with seeking**.
- Settings control:
  - **Auto-sync new content** on/off (new stories for Gunner, new chapters for Holdfast).
  - **Auto-download** on/off — Gunner: new stories; Holdfast: option to download **entire books**.
  - Storage usage display + clear downloads.

## Notifications
- Web push when new content publishes (works on installed PWA), with app badge.
- Enable/disable from Settings.

## Content pipeline
- Site repo markdown is the **single source of truth** (holdfast site: the-keepers pages; gunner site: story collection). The app database holds **user state only** (accounts, progress, bookmarks, push subscriptions).
- Publish step pre-bakes: chapter/story JSON + narrated MP3 (Azure neural TTS) + word-timing files → per-brand R2 behind content.holdfastpress.com / content.gunnerthelab.com.
- Publishes are incremental (per-chapter content hash); full Gunner backfill fits one month of the Azure free tier.
- Planned: GitHub Actions auto-publish on push to the site repos (path-filtered to story/chapter folders).

## Hard rules
- holdfastpress.com/app marketing page: layout/content changes only on the author's explicit order.
- No secrets committed anywhere; keys live in Key Vault (kv-hcs-vault-01) + Wrangler secrets.
- Detailed design docs maintained in docs/.
