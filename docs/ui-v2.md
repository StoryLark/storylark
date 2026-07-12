# UI v2 — screens, navigation, modes, settings

UI v2 replaces the original three-screen app (Library → Reader → Settings) with a
four-tab layout and three explicit consumption modes. All existing plumbing —
AudioController word-sync, SpeechFallback, IndexedDB progress outbox, downloads
cache with SW Range serving, Media Session, payload-less push — is reused, not
rewritten.

## Navigation

A persistent bottom tab bar (`components/TabBar.tsx`) is on every screen:

| Tab | Route | Notes |
|---|---|---|
| Home | `/` | New start route |
| Library | `/library` | Also lights up for `/library/:bookId` and `/read/...` |
| Now Playing | `/now-playing` | Dimmed when nothing is loaded; accent badge dot while audio plays |
| Settings | `/settings` | |

Routes (`router.ts`): `home`, `library`, `book` (`/library/:bookId`),
`now-playing`, `reader` (`/read/:bookId/:chapterId?mode=read|both`), `settings`.

## Screens

### Home (`screens/Home.tsx`)
- **Preview banner** (`components/PreviewBanner.tsx`, both brands): "StoryReader
  is in preview…" — dismissible per session via `sessionStorage`, returns on the
  next app open.
- **Continue card**: the most recently touched unfinished item from the local
  progress store. Tapping resumes in the saved mode (listen → Now Playing,
  read → Reader).
- **New section**: recently added stories (gunner) or chapters (holdfast),
  newest first by `publishDate`/`publishedAt`. Undated entries (older manifests)
  keep manifest order and sort after dated ones.

### Library (`screens/Library.tsx`)
- **gunner** — flat list of all stories with **search** (title + era label +
  description) and **sort** (story order / title A–Z / newest). Each row: cover,
  era, duration or reading time, progress bar, a play button (straight to Now
  Playing) and a tap-to-open in the item's mode.
- **holdfast** — hierarchical, Audible-like: Series → Book cards → Book screen
  (`screens/Book.tsx`) with cover hero, description, overall progress (weighted
  by word count), a prominent **Resume/Start** button, and per-chapter rows with
  play/read actions and per-chapter progress. Manifests without series metadata
  fall back to a single shelf named after the brand.

### Now Playing (`screens/NowPlaying.tsx`)
Artwork (book cover, brand icon fallback), chapter/book titles, mode chip,
scrubber with elapsed/remaining time, play/pause, ±15 s skips, playback speed
cycle (0.75×–2×), chapter/story picker, and a read-along shortcut that opens the
Reader in Read + Listen mode. Items without pre-generated audio play through the
Web Speech fallback (no scrubbing). Media Session (lock-screen controls) is wired
by the player for every item.

### Reader (`screens/Reader.tsx`)
Renders text with a three-way mode control in the header (Read / Read + Listen /
Listen). Read is text-only with scroll-position progress. Read + Listen preloads
the item into the global player, attaches the text container to the
AudioController for word-sync highlighting, and shows a mini player bar above the
tab bar. Choosing Listen hands off to Now Playing (audio keeps playing across
navigation).

## Consumption modes

Three explicit modes: **LISTEN** (Now Playing, no text), **READ** (text only),
**READ + LISTEN** (text with word-sync highlight following audio).

- Per-item overrides are stored in IndexedDB (`itemModes` in `lib/state.ts`) and
  set whenever the user picks a mode explicitly (Reader mode control, Book row
  read/play buttons).
- The default for untouched items is `Settings → Playback → Default mode`.
- `lib/open-item.ts#openItem` resolves override → default and routes accordingly.

## Global player (`lib/player.ts`)

Single owner of the shared `AudioController`/`SpeechFallback`. Exposes signals
(`nowPlaying`, `playerPlaying`, `playerPositionMs`, `playerDurationMs`,
`playerRate`) that the Now Playing screen, the Reader mini player, and the tab
badge all render from. Handles resume-from-progress, 30 s progress persistence
(`mode: 'listen'`, same worker API as before), auto-advance to the next
chapter/story, and Media Session wiring. `AudioController.setContainer()` lets
the Reader attach/detach its text for highlighting without interrupting audio.

## Settings v2 (`screens/Settings.tsx`)

Persisted in IndexedDB with the existing settings record (new fields are
additive; old saves merge over defaults):

- **Default mode** — read / listen / read + listen.
- **Check for new content automatically** (`autoSync`, default on) — on app open
  and on regaining connectivity, `lib/autosync.ts` probes
  `/api/library/version`, refreshes the manifest, and fetches the text of new or
  changed chapters (the SW runtime cache keeps them).
- **Auto-download** (`autoDownload`, default off) — gunner: stories added after
  the toggle was enabled download automatically incl. audio (a baseline of
  existing keys is recorded on enable); holdfast: keeps the entire book
  downloaded incl. audio.
- **Notifications** — existing push subscribe/unsubscribe.
- **Storage & downloads** — download usage, `navigator.storage.estimate()`
  totals, per-item download/remove, and **Clear all downloads**.

## Manifest schema (backward-compatible)

`tools/publish.mjs` now emits optional book-level fields:
`series`, `seriesOrder`, `bookOrder`, `description`, `publishDate`.
`schemaVersion` stays `1` — the fields are additive and every consumer treats
them as optional. The already-published holdfast v1 manifest (no series
metadata) keeps working: the Library falls back to a single shelf and the Home
"New" section falls back to chapter `publishedAt` (already present live).

To push the richer schema without re-publishing content:

```
node tools/publish.mjs --brand holdfast --manifest-only
```

(New flag — regenerates and uploads only `manifest.json` from publish state,
bumping `libraryVersion`.)
