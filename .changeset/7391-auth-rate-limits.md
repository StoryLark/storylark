---
"storylark-worker": patch
---

Close two authentication endpoints that had no rate limiting on a guessable 6-digit code (`/api/auth/password/reset`, `/api/auth/code/verify`) — either could previously be brute-forced with no throttle. Also add per-email-address rate limits to `/password/forgot` and `/magic/request`, on top of the existing per-IP limits, to stop an IP-rotating caller from mail-bombing one address (AB#7391).
