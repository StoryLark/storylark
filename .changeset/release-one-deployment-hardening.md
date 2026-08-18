---
"create-storylark": minor
"storylark-core": patch
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
Add explicit matching-only adoption for existing live libraries: complete
chapter, rendered-content, metadata, order, and cover parity is required before
ownership can move to repo sync, while narration and content objects remain
untouched. Read GitHub repositories path-first, batch authenticated Markdown
reads to stay within the Workers Free subrequest budget, preserve legacy
single-story chapter ids, and keep root-relative artwork hash-compatible with
the publish pipeline.
Update demo content and deployment documentation for both standalone stories
and multi-chapter books, and move Sharp to its patched release.
