---
"storylark-pipeline": patch
---

Fix three real bugs in the CLI publish path found via production CI failures (AB#7654):

- A fresh runner with no local publish state no longer reports already-published chapters as false conflicts — the baseline is now reconstructed from the live manifest and chapter content when local state is missing.
- `--no-audio` no longer strips existing narration metadata (audio/timings/voices/hasAudio) from already-narrated chapters on a stateless run; it now means "upload no new audio," never "delete existing narration."
- Fixed a Windows-only crash (`UV_HANDLE_CLOSING` assertion) that could make a clean `--dry-run` report a CI failure.
