---
'storylark-worker': patch
---

Fix the Postgres driver returning COUNT(*)/bigint columns as strings instead
of numbers, a real cross-platform response-shape divergence (confirmed live:
Azure's `/api/admin/status` reported `pushSubscriptions` as `"0"` while
Cloudflare reported `0`, same brand, same data). Registers a `pg` type
parser for bigint (OID 20) once, so every count/bigint column now returns a
plain number on Postgres, matching D1/SQLite's native behavior.
