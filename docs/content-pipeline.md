# Content pipeline

## Sources

| Brand | Repo | Files |
|---|---|---|
| holdfast | holdfast-press.github.io | `src/pages/the-keepers/*.md` (published chapters only) |
| gunner | gunnerthelab.github.io | `src/content/stories/*.md` (42 stories, skip `draft: true`) |

## Prose conventions → block types (tools/lib/md.mjs)

| Markdown | Block | Rendered |
|---|---|---|
| `---` on its own line | `scene-break` | centered `— · —` |
| `> **Name (8:01 PM):** text` (consecutive quotes merge) | `message-block` | dark mono phone-UI card |
| `*End of Chapter One.*` | `end-marker` | centered italic, extra top margin |
| whole-paragraph single `*…*` | `display-beat` | centered italic |
| anything else | `paragraph` | first-line indent (except after breaks); `spans` carry em/strong offsets |

A paragraph like `*on my way,* he wrote back. *no fights yet.*` is NOT a display beat — the display-beat test requires one italic span covering the entire line.

## Block IDs

Sequential (`b001`…) on first publish; on republish, blocks whose (type + plain text) hash matches a previous block keep their old ID (`stabilizeBlockIds`), so bookmarks/progress survive edits elsewhere in the chapter. A heavily rewritten chapter may reset mid-chapter positions — acceptable.

## Chapter JSON / timings schemas

See `app/src/lib/types.ts` (`ChapterContent`, `ChapterTimings`) — the app types are the schema of record. Word timing entries are `[charStart, charEnd, startMs, endMs]`, char offsets relative to the block's plain text, times relative to chapter audio start.

## TTS specifics

- Azure Speech SDK real-time synthesis per block (F0-compatible; batch API is S0-only).
- Word boundaries: `audioOffset` is 100 ns ticks (`/10000` → ms); `textOffset` is relative to the SSML document — the pipeline subtracts the SSML prefix and un-escapes entity offsets.
- Scene breaks become 900 ms of stitched silence, not SSML breaks (chunks stay per-block).
- Chunk durations measured with ffprobe (trailing silence would drift the accumulated offsets otherwise), then `ffmpeg -f concat -c copy`.
- F0 pace: 3.1 s between requests → a ~90-block chapter takes ~5 min.

## Runbook — publish a new Keepers chapter

1. Chapter goes live on the site repo (existing flow).
2. `node tools/publish.mjs --brand holdfast --dry-run` — confirm exactly the new chapter is CHANGED.
3. Set `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION`/`ADMIN_KEY`; run without `--dry-run`.
4. Verify: chapter appears in the app library; audio plays; word highlight tracks at start/middle/end.
