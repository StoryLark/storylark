# Install

Every way to get a branded StoryLark site running, from "just try it" to "one
command to a live URL."

## Recommended: create a standalone publisher site

**`npm create storylark`** generates a thin site and runs `npm install` for
you. The result contains exact compatible versions of `storylark-core`,
`storylark-worker`, and `storylark-pipeline`, plus a package lock and a
non-secret `.storylark/project.json` provenance marker. It does not copy the
engine source or create a monorepo.

```
npm create storylark my-site
```

Use `npm run doctor` in the new folder before setup, or
`npm run doctor -- --json` in automation. `--no-install` exists only for an
advanced operator who deliberately wants to manage dependency installation;
it cannot be combined with `--deploy`.

## Installing to a platform

Every platform folder (`platforms/cloudflare/`, `platforms/azure/`) is
driven by an **env file** — fill it in, run that platform's installer.
`--verify` checks everything (login state, config validity, that the
infrastructure template compiles) and creates nothing; `--deploy --yes`
provisions real resources.

```
cd platforms/cloudflare        # or platforms/azure
cp install.env.example install.env
$EDITOR install.env
node install.mjs --verify
node install.mjs --deploy --yes
```

See [`deploy-your-own.md`](deploy-your-own.md) (Cloudflare) or
[`deploy-azure.md`](deploy-azure.md) (Azure) for what each env value means
and what gets created.

## The setup wizard

Don't want to fill out two files by hand (the env file plus your brand)?
The wizard asks which platform, collects the values, writes the env file,
and runs that platform's installer for you:

```
node platforms/wizard.mjs
```

The wizard verifies first, then asks for confirmation before it deploys. A
non-interactive deployment must state both `--deploy` and `--yes`.

Non-interactive (scriptable) form:

```
node platforms/wizard.mjs --platform=cloudflare --deploy --yes BRAND_ID=my-site APP_ORIGIN=https://app.example.com ...
```

Works identically whether you cloned the repo or ran `npm create storylark`
— it's the same script either way.

## The one-command path

`npm create storylark my-site -- --deploy` chains straight from scaffolding
into the wizard — one command, a few prompts, done. This is the "seamless"
path: you never see the copy step and the wizard as separate actions, just
one continuous flow ending at a live site.

## Advanced: clone the engine

Clone `StoryLark/storylark` only when you intend to develop, debug, or fork the
engine itself. It is a workspace checkout, not the normal way to operate one
publisher site:

```
git clone https://github.com/StoryLark/storylark.git
cd storylark
npm install
```

Running `npm install` at the workspace root is required. A clone without that
step is not an installed StoryLark deployment.

## What every path has in common

Regardless of how you got here, you end up with:

- A brand folder (`brands/<id>/`) — yours to edit, never touched by an
  engine update. See [`build-your-own-theme.md`](build-your-own-theme.md).
- A CI setup (`.github/workflows/`) with `publish.yml` already wired up, for
  content publishing — see [`admin-guide.md`](admin-guide.md). Engine updates
  need no CI at all: they run from your machine with one command, see
  [`updating.md`](updating.md).
- An empty shelf until you publish. See
  [`publishing-stories.md`](publishing-stories.md).
