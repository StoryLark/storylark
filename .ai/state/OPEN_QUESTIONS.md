# Open questions

<!-- Unresolved questions or deferred decisions for the next session or tool to pick up. -->

## Forgot-password flow (2026-07-11)

Password accounts now have no in-app account-recovery path: if someone
forgets their password, there's nothing in the UI to help. The magic-link
and 6-digit-code endpoints (`/api/auth/magic/request`, `/api/auth/magic/verify`,
`/api/auth/code/verify`) are still fully functional and were deliberately kept
around specifically as a foundation for this (see `docs/auth.md`), but no
"forgot password?" link or reset-password screen exists yet. Worth a small
follow-up task: a link from the Sign in form to "email me a code" (reusing the
existing magic-code UI pattern that used to live on this screen) that, once
verified, lets the user set a new password rather than just signing them in.

## No rate limiting on `/api/auth/register` or `/api/auth/login` (2026-07-11)

Unlike `/api/auth/magic/request` (3 per 15 min per email), the new password
endpoints have no attempt limiting. PBKDF2's own cost (100,000 iterations
per attempt) provides some throttle against a single-request brute force,
but nothing stops a distributed attempt, and `/register` has no cap on how
many accounts one caller can create. Not built because the task didn't ask
for it and this repo has no existing per-IP rate-limiting mechanism to
extend (Cloudflare's own WAF/rate-limiting rules, configured outside this
codebase, may already cover this at the edge; not verified either way).
