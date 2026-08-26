# Repo intent — storylark

**Read it. Hear it. Carry it with you.**

## What this repo is

StoryLark is the open-source, self-hostable engine for building a branded,
installable story-reading app: a Preact + Cloudflare Workers PWA with word-synced
neural TTS narration, offline downloads, cross-device sync, and per-brand theming.
It runs as a single Cloudflare Worker backed by D1 and R2. This is the **core engine
repo** — the base brand ships with no publisher content; a publisher brings their
own stories through the pipeline.

**Status: 1.0 release candidate.** Public contracts are frozen for 1.0.0 — see
`docs/stability.md` for the supported surface and compatibility promise.

## Shape

- `app/`, `packages/` — the engine itself (Preact frontend, Worker backend)
- `brands/`, `themes/`, `presentation/` — per-deployment brand/theme configuration
- `create-storylark` — the scaffolding CLI for new deployments
- `deployment/`, `platforms/`, `integrations/` — deploy targets and third-party hooks
- `docs/` — including the stability policy

## How it relates to other repos

- **`storylark-org`** — the marketing/docs site (storylark.org)
- **`storylark-dev`** — the live public demo deployment, always built from this repo's
  latest `main`
- **`gallery`** — the open library of themes and presentation templates for this engine
- Brand-specific deployments elsewhere (e.g. `storylark-gunner`, `storylark-holdfast`)
  consume this engine as a pinned npm dependency — they never fork this code

## Status

Active, 1.0 RC. This is the upstream everyone else depends on.
