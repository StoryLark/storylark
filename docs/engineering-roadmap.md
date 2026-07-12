# Roadmap & verification

| Phase | Deliverable | Verification | Status |
|---|---|---|---|
| 0 | Toolchain, repo scaffold, docs, brand configs | themed shell builds | done |
| 1 | Parser + chapter JSON (prologue/chapter-one) | blocks match live site rendering | done |
| 2 | Worker + D1 + assets on app.holdfastpress.com | `/api/library/version` → 200; installable | in progress |
| 3 | Auth (magic link) + sessions | flow on desktop + phone | code done; needs RESEND_API_KEY wired |
| 4 | Library + Reader + progress sync | cross-device position matches; offline outbox replays | code done; needs live verify |
| 5 | TTS pipeline for prologue | word sync ±150 ms at 3 spot checks | code done; needs Azure F0 |
| 6 | Listen mode (player, highlighter, Media Session, fallback) | lock-screen controls; tap-word seek | code done; needs live verify |
| 7 | Offline downloads + SW Range serving | airplane mode: read AND play with seek | code done; needs live verify |
| 8 | Web push + admin publish + badge | notification on installed PWA | code done; needs VAPID + live verify |
| 9 | Gunner (config-only) | zero shared-code changes | pending |
| 10 | UI v2 — Home + tab nav + Now Playing + Library v2 + modes + Settings v2 (see [ui-v2.md](ui-v2.md)) | typecheck + both brand builds green; needs live verify + holdfast `--manifest-only` republish for series metadata | code done; not deployed |

Update this table as phases verify. "Code done" means written and typechecked, not yet exercised end-to-end.

## Deferred — future sign-in providers (both apps)

Author decision 2026-07-06: ship with magic-link email only; add social sign-in later.

| Provider | Scope | Notes |
|---|---|---|
| Google | Holdfast + Gunner | Worker route already written (`/api/auth/google/callback`). Needs one Google Cloud project (consent screen External + published, web client) with both redirect URIs: `https://app.holdfastpress.com/api/auth/google/callback` and `https://app.gunnerthelab.com/api/auth/google/callback`. Then set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` per env. One project covers both apps. |
| Apple (Sign in with Apple) | Holdfast + Gunner | Not yet coded — needs a worker route + button. Requires an Apple Developer account ($99/yr), a Services ID per app domain, a signing key, and domain verification. Revisit if/when the apps target the App Store or Apple-heavy readership justifies the cost. |
