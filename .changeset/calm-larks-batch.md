---
"storylark-worker": patch
---

Batch repository-sync ownership and metadata updates into one manifest write so large standalone-story libraries complete within Worker execution limits. Unchanged cover assets are no longer rewritten during a no-op sync.
