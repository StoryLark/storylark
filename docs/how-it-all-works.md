# How It All Works — the plain-English tour

Written for the author, not the compiler. Everything here has a deeper technical
companion doc; this is the map.

## The cast of characters

| Piece | Where | What it is |
|---|---|---|
| **Site repos** | holdfast-press.github.io, gunnerthelab.github.io | Where you write. Markdown stories, same as always. **The single source of truth.** |
| **App repo** | holdfast-press/storyreader | All the app code, this docs folder, and the publish pipeline. One codebase for both brands. |
| **The Worker** | app.holdfastpress.com (later app.gunnerthelab.com) | The app itself, running on Cloudflare's edge. Serves the screens and the small API (sign-in, reading positions, bookmarks, notifications). |
| **The database (D1)** | one per brand, inside Cloudflare | **People things only**: accounts, where each reader stopped, bookmarks, notification subscriptions. Never stories. |
| **Content storage (R2)** | content.holdfastpress.com (later content.gunnerthelab.com) | The published stories, pre-baked: text JSON + narration MP3 + word timings + covers. Served like static files, cached worldwide. |
| **The publish pipeline** | `tools/` in the app repo | The kitchen: takes your markdown, produces everything R2 holds, tells the app "new content!". |
| **Azure Speech** | storyreader-tts (thisismydemo) | The narrator. Free tier, 500K characters/month, watched by a built-in ledger. |

## What happens when you publish

```
you push markdown ──► publish pipeline
                        ├─ parses it into reader blocks (scene breaks, text-message cards, italics…)
                        ├─ narrates each paragraph (per-word timestamps collected)
                        ├─ stitches one MP3 per chapter (ffmpeg)
                        ├─ uploads text + audio + timings to the brand's content domain
                        └─ bumps the library version → push notification to subscribers
```

Only new or changed stories are processed — the pipeline fingerprints everything.

## What happens when a reader opens the app

1. The app shell loads from the Worker (or instantly from the phone's cache if installed).
2. It fetches `manifest.json` from the content domain — the library card catalog: books, chapters, word counts, which have audio.
3. Reader taps a chapter → the app fetches that chapter's text JSON and renders it with the same look as the website (scene breaks, message cards, the works).
4. Tap **Listen** → the MP3 streams, and the timing file drives the word-by-word highlight. Tap any word to jump the audio there.
5. Their position saves every 30 seconds — locally first (works offline), then to the database when signed in, so the phone picks up where the laptop stopped. Newest write wins; devices can't fight.
6. **Download** stores text + audio on the device; airplane mode reads and plays fine, including seeking.

## What signing in does (and doesn't do)

- Without an account: everything works on that one device (positions save locally).
- With an account (email link or Google): positions and bookmarks sync across devices.
- We store: email address, display name (if Google), reading positions, bookmarks. Nothing else. Passwords don't exist — the email link *is* the sign-in.

## The two-brand model

One codebase; each brand is a **flavor baked at build time**: its own colors, fonts, icons, narrator voice, domains, database, and content bucket. Gunner's deployment is a configuration exercise, not new code — that's the acceptance test. Nothing is shared between brands at runtime.

## What it costs

Designed to run at **$0/month** at current scale: Cloudflare free tier (app hosting, database, content storage with free bandwidth), Azure Speech free tier (narration, ledger-enforced), Resend free tier (sign-in emails). The paid cliff is far away and the pipeline warns before you hit the one limit that renews monthly (TTS characters).

## Where to go deeper

- `runbook.md` — publish a story, step by step
- `architecture.md` — the system diagram + the load-bearing decisions
- `content-pipeline.md` — parsing rules, TTS details, block schema
- `api.md` — every API endpoint
- `data-model.md` — database tables + on-device storage + how sync stays consistent
- `auth.md` / `push.md` / `pwa-offline.md` / `read-along.md` — each subsystem
- `deploy.md` — infrastructure bootstrap + secrets
- `engineering-roadmap.md` — phase status, what's verified, what's next
