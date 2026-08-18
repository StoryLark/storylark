---
"create-storylark": minor
"storylark-contracts": patch
"storylark-worker": patch
"storylark-pipeline": patch
---

Make npm-create the safe publisher default: install and lock all three
StoryLark packages, record project provenance, verify before deployment, and
ship read-only local/live diagnostics. Support existing Cloudflare resource
names without changing brand identity.

Treat repository validation as an atomic gate, report duplicate book
declarations, and preserve narration/timing/voice metadata on no-op syncs.
Update demo content and deployment documentation for both standalone stories
and multi-chapter books, and move Sharp to its patched release.
