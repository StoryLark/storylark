# Install

Every way to get a branded StoryLark site running, from "just try it" to "one
command to a live URL."

## The two starting points

**Clone the engine repo** — you get everything: the packages, the base
brand, the docs, and both platforms' deploy tooling in `platforms/`.

```
git clone https://github.com/StoryLark/storylark.git
cd storylark
npm install
```

**`npm create storylark`** — a thin, standalone site is generated for you in
a new folder: an entry file, config, a brand seeded from the base theme, and
`platforms/` copied in. No engine source, no monorepo — just your site.

```
npm create storylark my-site
```

Both starting points end up with the same `platforms/` tooling available, so
everything below works from either one.

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

Non-interactive (scriptable) form:

```
node platforms/wizard.mjs --platform=cloudflare BRAND_ID=my-site APP_ORIGIN=https://app.example.com ...
```

Works identically whether you cloned the repo or ran `npm create storylark`
— it's the same script either way.

## The one-command path

`npm create storylark my-site -- --deploy` chains straight from scaffolding
into the wizard — one command, a few prompts, done. This is the "seamless"
path: you never see the copy step and the wizard as separate actions, just
one continuous flow ending at a live site.

## What every path has in common

Regardless of how you got here, you end up with:

- A brand folder (`brands/<id>/`) — yours to edit, never touched by an
  engine update. See [`build-your-own-theme.md`](build-your-own-theme.md).
- A CI setup (`.github/workflows/`) with `self-update.yml` and `publish.yml`
  already wired up — see [`updating.md`](updating.md) and
  [`admin-guide.md`](admin-guide.md).
- An empty shelf until you publish. See
  [`publishing-stories.md`](publishing-stories.md).
