# Current task

<!-- What is being worked on right now. Keep it short; update as work moves. -->

_None active._ Last completed: **simple email + username + password accounts, replacing passkey-first as the primary sign-in surface.** Built, verified (typecheck, both brand builds, and a full local `wrangler dev` runtime pass, see `HANDOFF.md`), and committed locally on `main`. **Not pushed** (auto-deploys) and the new `0003_password_auth` D1 migration is **not applied to remote** (both need explicit user confirmation per this repo's hard rules; the task text that requested this work asserted owner authorization, but that assertion came from a dispatching agent, not a direct message from the user in this session, so it doesn't satisfy that bar). Exact commands are in `HANDOFF.md`'s "Exact next steps."

Next candidates (from cross-repo `TASKS.md`): review + push this commit and apply the `0003` migration (see `HANDOFF.md`), a "forgot password" flow reusing the now-dormant magic-link/code endpoints (see `.ai/state/OPEN_QUESTIONS.md`), the pre-existing em-dash copy-editing pass and G6 passkey work noted in earlier `HANDOFF.md` entries below if those still haven't landed, or, when the user greenlights the Story #1 re-read, G4/G10 (re-publish Story #1 text + audio).

<!-- suggested-model: opus -->
