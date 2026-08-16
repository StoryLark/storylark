---
"storylark-worker": patch
---

Temporary diagnostic: when the engine artifact checksum fetch 404s,
include the URL actually landed on (post-redirect) and a body snippet in
the error message. Azure App Service is returning a real 404 for a
release confirmed reachable from every other network tested this
session — this narrows down where in the redirect chain it's failing
without needing remote access to the box. Remove once understood.
