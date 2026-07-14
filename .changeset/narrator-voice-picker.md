---
"storylark-core": minor
"storylark-pipeline": minor
---

Narrator voice picker — a library can now offer multiple narrator voices.

- Pipeline: `brand.json` `tts.voices` lists every voice the library ships;
  extras publish as per-voice audio + word-timing tracks (with automatic
  backfill for already-published chapters), and the manifest carries a
  `voices` map of display names.
- App: a "Narrator" picker appears in Settings whenever the library publishes
  2+ voices; the choice is synced across devices, applies on the next play,
  and downloads keep the chosen narrator available offline. Older manifests
  without voices keep working unchanged.
