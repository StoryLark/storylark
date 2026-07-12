# StoryLark - Plan (outline)

A high-level outline only. Details come later. Items here are tracked in this `/pmo`
folder for now; once the Azure DevOps project exists, tasks move to ADO
(dev.azure.com/hybridcloudsolutions, referenced as `AB#<id>`).

**Status: PRIVATE. Do not make public until the Open-source readiness gate below is met
and the owner has verified it clean.**

## Vision
- An open-source, self-hostable read-along storybook reader.
- Fully customizable through config files: clone it, configure a brand, deploy. No code
  changes needed to rebrand.
- The two existing apps, gunner and holdfast, will be converted to run on StoryLark as
  customized brand configs (they become downstream brands on one shared codebase, not
  separate forks).

**Sequencing (owner intent): start developing StoryLark soon, while it stays PRIVATE.
Converting gunner and holdfast to StoryLark configs is an early goal. Going public stays
gated on the Open-source readiness workstream.**

## Two front-ends
- `storylark.org` - public marketing / landing page.
- `storylark.dev` - live demo of the app.

## Open decisions (decide later, not tonight)
- **Hosting: GitHub Pages vs Cloudflare** for `.org` and `.dev`. The repos so far were
  created GitHub-style (`storylark.github.io`); confirm or change this.
- **Repo topology, tied to the hosting choice:**
  - If Cloudflare Pages for both `.org` and `.dev`: how many repos (one each, or shared)?
  - If GitHub Pages for both: how many repos (one each, or shared)?
  - Does the `.dev` demo need its own repo, or is it just a deploy of `storylark`?
- **LICENSE: MIT vs Apache-2.0.**

## Workstreams (outline)

### 1. Open-source readiness (the gate to going public)
Do NOT flip public until these are done (details already in `todo.md` and `REPO_INTENT`):
- Genericize: strip the `gunner` and `holdfast` brands.
- Config-driven customization: everything brandable lives in config files, documented.
- Remove environment-specific config (Cloudflare/D1 ids, domains, mail-from), use placeholders.
- Rename internal `storyreader` to `storylark`.
- Add LICENSE + public README.
- Rebuild history fresh from the genericized tree, then owner verifies, then flip public.

### 2. Strip gunner + holdfast (genericize)
- Replace the two brands with one neutral `example` brand.
- Write a "how to add your own brand" guide.

### 3. Public landing page (storylark.org)
- Build the marketing page (repo + hosting per the decision above).

### 4. Demo (storylark.dev)
- Deploy the app as a public demo (a `demo` brand instance).

### 5. Features backlog (many - outline)
- Screen Awake setting (read-along), first up.
- More features to be listed here over time.

### 6. Adopt StoryLark for gunner + holdfast
- Convert the two live apps (gunner, holdfast) to run on the StoryLark codebase, each via
  its own brand config. StoryLark becomes the single upstream; the brands are downstream.
- Proves the config-driven model on real brands. Can proceed while StoryLark is private.

## Internal tooling
- `/docs` - internal documentation for building and running StoryLark.
- `/pmo` - task tracking for now (this file lives here). Move to ADO when the project exists.
