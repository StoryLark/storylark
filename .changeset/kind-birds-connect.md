---
"storylark-worker": patch
"create-storylark": patch
---

Let the supported Cloudflare installer choose Portal, Repository, or CMS/API content during setup. Repository setup provisions the read credential as a platform secret, runs the same fail-closed validation gate as Admin, saves the connection, and performs the initial sync. Generated narration jobs now install FFmpeg, while the advanced clone-based sync workflow stays skipped until explicitly configured.
