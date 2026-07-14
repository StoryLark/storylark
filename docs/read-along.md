# Read-Along (word-synced narration)

## Where the timing data comes from

At publish time, Azure Speech emits a **WordBoundary event** for every word it
speaks (offset in 100-nanosecond ticks + character position in the text). The
pipeline converts those to `[charStart, charEnd, startMs, endMs]` per word, shifts
each block's times by its measured position in the stitched chapter MP3 (ffprobe
measures real chunk durations — trailing silence would drift a naive sum), and ships
the result as the chapter's timings JSON. Verified accuracy: ~24 ms drift per minute.

## How the highlighter works (packages/core/src/reader/)

- A `requestAnimationFrame` loop reads `audio.currentTime` while playing
  (`timeupdate` only fires ~4 Hz — too coarse for word highlighting).
- Binary search over the flattened word array finds the current word.
- **Only the active block** has its text split into word `<span>`s; every other
  block stays plain text nodes. A 400-block chapter never bloats the DOM. When the
  active block changes, the previous one is restored (italics re-applied).
- The active block auto-centers with smooth scrolling — unless the reader scrolled
  manually in the last 5 seconds (their intent wins).
- **Tap a word → seek there.** Timing entries map char offsets back to milliseconds.
- Modes (Settings): word-by-word / paragraph-only / off.

## Chapters without pre-made audio (Web Speech fallback)

If a chapter ships text-only (`hasAudio: false`), Listen mode uses the device's own
text-to-speech:

- Chrome kills long utterances mid-sentence → we speak **sentence by sentence**.
- iOS fires word-boundary events unreliably → highlight at **paragraph level** there.
- Position saves as a character offset, same as read mode.

It's the budget narrator: always available, never as good as the real one.

## Media Session (lock screen)

Chapter title, book, and cover appear on the lock screen / headphone controls with
play/pause, ±15/30 s skip, and previous/next chapter — wired through the Media
Session API in `packages/core/src/lib/mediasession.ts`.
