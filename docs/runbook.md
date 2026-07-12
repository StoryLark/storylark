# Publishing Runbook — The Keepers & Gunner the Lab

The one-page guide for getting a new story from your keyboard into the app.

## The golden rule

**You write markdown in the site repo and push it. That's the whole job.**
The website publishes it (as today), and the StoryReader pipeline turns that same file into app content: structured text + narrated audio + word-sync timings.

---

## Publishing a new Keepers chapter

1. Write the chapter as `src/pages/the-keepers/<chapter-name>.md` in **holdfast-press.github.io**, with the usual frontmatter (`title`, `chapterLabel`, `readingTime`, optional `setting`, `prev`/`next`). Same conventions as prologue/chapter-one:
   - `---` on its own line = scene break
   - a paragraph that is entirely one `*italic line*` = centered display beat
   - `> **Name (8:01 PM):** text` lines = phone/text-message card
   - end with `*End of Chapter X.*`
2. Commit + push to the site repo. The website goes live as normal.
3. Add the chapter id to the `ORDER` list in `storyreader/tools/parse/holdfast.mjs` (one line — keeps library order right).
4. Run the publish (until the auto-pipeline is wired — see below):
   ```powershell
   cd D:\git\holdfast-press\storyreader
   $env:AZURE_SPEECH_KEY = '<key>'; $env:AZURE_SPEECH_REGION = 'eastus'; $env:ADMIN_KEY = '<prod admin key>'
   node tools/publish.mjs --brand holdfast --dry-run   # sanity check: ONLY the new chapter shows CHANGED
   node tools/publish.mjs --brand holdfast             # ~15-20 min (TTS runs at free-tier pace)
   ```
5. Done. The app library updates, subscribers get a push notification. Verify: open app.holdfastpress.com, play the first minute, check the highlight tracks.

## Publishing a new Gunner story

1. Write `src/content/stories/NN-story-name.md` in **gunnerthelab.github.io** with the usual frontmatter (`title`, `storyNumber`, `era`, `eraLabel`, `description`, `publishDate`, `coverImage`, `draft: false`, `order`).
2. Commit + push. Website live as normal.
3. Run the publish:
   ```powershell
   node tools/publish.mjs --brand gunner --dry-run
   node tools/publish.mjs --brand gunner
   ```
   No parser edits needed — Gunner stories are discovered automatically; `order`/`era` control grouping.

## What the pipeline does with your push (automatically)

- Fingerprints every story; **only new or changed ones are processed** — everything else is skipped.
- Parses the markdown into reader blocks (scene breaks, message cards, display beats, italics preserved).
- Narrates each paragraph with the brand's voice (Holdfast: en-GB-Ryan; Gunner: en-US-Andrew), collecting per-word timestamps for the read-along highlight.
- Stitches the audio into one MP3 per chapter, uploads text + audio + timings to the brand's content domain.
- Uploads the updated library manifest **last**, bumps the app's library version, and fires the push notification.

## Fixing a typo in an already-published story

Just edit the markdown and republish. The fingerprint changes, that one story regenerates. If it's a tiny fix and you don't want to re-narrate, use `--no-audio` — the old audio is kept when the text barely moved.

## Free-tier guardrails (the pipeline enforces these itself)

- **Azure TTS: 500K characters/month free.** The pipeline keeps a monthly ledger and refuses to start a narration that would cross 450K — it tells you to publish text-only (`--no-audio`) or wait for the 1st. A Keepers chapter ≈ 10–25K chars; the entire Gunner backlog ≈ 430K (fits one month).
- **Pace: 20 requests/minute** — a chapter takes ~5 min of synthesis; this is normal, not a hang.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `--dry-run` shows a story as CHANGED that you didn't touch | Frontmatter or whitespace edit — harmless; it'll republish cleanly. |
| Publish stops with "char budget" message | Monthly TTS ledger guard — `--no-audio` now, audio next month. |
| New chapter missing from app library | Holdfast only: did you add it to `ORDER` in `tools/parse/holdfast.mjs`? |
| App shows old content on a phone | The manifest caches for 60 s; pull-to-refresh or reopen. Downloaded copies update when the user re-downloads. |
| Push notification didn't arrive | iPhone requires the app installed to Home Screen; check Settings → Notifications toggle in the app. |

## Coming next (planned, not yet wired)

A GitHub Action **in each site repo**, filtered to the story folders only, so step 4 disappears entirely: pushing the markdown runs the publish in the cloud. Prereqs tracked in `docs/engineering-roadmap.md` (move the publish ledger into the content bucket; add the four secrets to each site repo).
