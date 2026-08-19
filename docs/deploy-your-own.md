# Deploy your own site on Cloudflare

The supported Cloudflare deployment is a thin publisher project created from
npm. It pins the StoryLark engine, Worker, and pipeline as dependencies and owns
only your brand, presentation, deployment settings, workflows, and content.
Cloning the engine is not part of this path.

## Prerequisites

- Node.js 20 or newer
- A Cloudflare account with Workers, D1, and R2 available
- Wrangler authenticated with `npx wrangler login`
- `ffmpeg` and `ffprobe` only when the machine running the publisher will
  generate narration

## Create the publisher project

For one guided flow from an empty folder to a deployment:

```text
npm create storylark my-site -- --deploy
```

To review and brand the project before provisioning anything:

```text
npm create storylark my-site
cd my-site
npm run doctor
npm run setup
```

The create command runs `npm install`, writes a package lock, pins compatible
versions of `storylark-core`, `storylark-worker`, and
`storylark-pipeline`, and records non-secret provenance in
`.storylark/project.json`. `--no-install` is an advanced escape hatch and
cannot be combined with `--deploy`.

A cloned engine workspace is not an installed publisher site. If you
intentionally clone the engine to develop or fork StoryLark, run `npm install`
at its root before using any workspace command.

## Brand the generated site

The generated project separates three contracts:

```text
brands/<id>/brand.json                identity
brands/<id>/theme.css                 visual tokens
presentation/<id>/presentation.json  layout and vocabulary
deployment/<id>/deployment.json      origins and narration settings
```

Edit the brand and presentation before or after the first deployment. Runtime
theme packages and brand edits are stored separately from engine versions, so
an engine update does not overwrite them. See
[Build your own theme](build-your-own-theme.md) and
[Build your own presentation](build-your-own-presentation.md).

## Run the setup wizard

`npm run setup` asks for the brand id, app URL, optional content URL, sender
identity, and app name. It writes the gitignored
`platforms/cloudflare/install.env`, verifies the values and Wrangler session,
and asks before creating resources.

The installer creates or configures:

- one Cloudflare Worker for the app and API;
- one D1 database and its migrations;
- one R2 bucket for content, runtime themes, and installed engine versions;
- the scheduled trigger used for update checks and saved repo connections;
- the first Admin setup link and recovery codes;
- self-update permission for API-server releases, unless you explicitly opt
  out.

Keep the setup link and recovery codes in a password manager. Do not commit
`install.env`, tokens, account identifiers, database identifiers, or secrets.

### Same-origin content is the default

Leave `CONTENT_ORIGIN` empty for the simplest deployment. The Worker serves
`/manifest.json` and `/books/*` from the R2 binding, so no second domain or
DNS setup is required.

Set a separate content origin only when you intentionally attach an R2 custom
domain. Audio and large content then bypass the Worker while R2 continues to
provide zero-egress delivery.

### Existing Cloudflare resources

The installer can adopt explicitly named existing Worker, D1, and R2 resources.
Resource names are deployment details; they do not rename your brand. Run
`npm run doctor` first and review the plan before confirmation. Adoption must
not replace content, theme, presentation, or identity merely to match a default
name.

## Verify before publishing

Run the read-only diagnostics locally:

```text
npm run doctor
npm run doctor -- --json
```

After deployment, verify the live origin, Admin sign-in, engine and Worker
versions, update preflight, and content manifest. Follow
[Deployment safety](deployment-safety.md) before changing an existing
production library.

## Publish a story or book

The generated project uses `content/` as its default Markdown source:

```text
npm run publish
```

A single `type: story` file publishes a standalone story. A
`type: book` declaration plus ordered `type: chapter` files publishes a
multi-chapter book; both shapes can coexist. The bundled narrator is the free
default on a local publisher machine. Use `--no-audio` only when you
intentionally want text-only content.

See [Authoring stories and books](authoring-stories.md),
[Publishing stories and books](publishing-stories.md), and the
[Content pipeline](content-pipeline.md).

## Operate the deployment

Open `/admin` for:

- **Stories & Books** — upload, edit, reorder, version, or delete
  deployment-owned content;
- narration status and retries;
- brand and **Theme version history**;
- **Connections** for repo connections saved through StoryLark;
- **Check for updates**, **Update now**, engine history, and rollback.

A GitHub Actions workflow that reads a repository and publishes through the
content API does not create an Admin repo connection. Use **Connect a repo** if
you want StoryLark to store and operate that connection. See the
[Admin guide](admin-guide.md).

## Manual and advanced reference

The generated project includes `platforms/cloudflare/install.mjs` and an
example `install.env` for scripted verification, deployment, update, repair,
and explicit self-update opt-out. The exhaustive bindings, variables, secrets,
and route behavior live in the
[engine deployment reference](https://github.com/StoryLark/storylark/blob/main/docs/deploy-worker.md).

Cloudflare free limits are real limits, not an unlimited-hosting promise. App
assets and API requests traverse the Worker so runtime engine updates can be
selected; published content can use the R2 custom domain. Review the current
[architecture and budget notes](architecture.md) before estimating production
traffic.
