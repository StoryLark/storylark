# Updating

How your deployed site receives platform updates — from the operator's
chair, not the code's.

## Nothing updates without you running it

StoryLark never updates itself. There is no background process that changes
what's running, and **by default your deployment holds no credential that
could deploy on your behalf.** An installed reading app has no business
storing a GitHub token just so it can rebuild itself, and it doesn't have
one — GitHub is not in this picture at all.

So updating has two parts: the site tells you a new release exists, and you
run one command from the machine you deploy from.

There is also a third, entirely optional part — a button in `/admin` — and
it is off until you deliberately turn it on. See
[One-click updates](#one-click-updates-optional) at the bottom. Everything
above that section is true whether or not you enable it: the command is the
supported path and it always works.

## Part 1 — how you find out

Two ways, both free of credentials:

1. **Check yourself** — open `/admin` on your site. The "Platform update"
   card shows what you're running versus the latest release, with a link to
   the release notes. The check is an unauthenticated read of the public npm
   registry.
2. **Get told** — if you've set `ADMIN_EMAIL` and `RESEND_API_KEY`, a daily
   check emails you when a new release exists. You never have to remember
   to look. See [`admin-guide.md`](admin-guide.md) for setting these up.

## Part 2 — the command

From your copy of the site, on the machine you already deploy from:

```bash
# Cloudflare
node platforms/cloudflare/install.mjs --update --yes

# Azure
node platforms/azure/install.mjs --update --yes
```

The `/admin` card shows the right one for your platform, ready to copy.

That command:

1. Pulls the latest engine packages from npm (`storylark-core` /
   `storylark-worker`), pinned exactly so what you deployed is reproducible.
2. Applies any pending database migrations.
3. Rebuilds the app — with your brand untouched.
4. Redeploys.
5. Prints what changed: old engine version → new engine version.

It authenticates with the platform login you already have — your own
`wrangler login` or `az login` session. It installs nothing on the
deployment, stores no new secret, and creates no infrastructure: `--update`
never runs `az deployment group create`, never creates D1 or R2, never
edits `wrangler.jsonc`. It is safe to run repeatedly, including when you're
already on the latest version (it just rebuilds and redeploys what you
have, which is also how you repair a deployment that has drifted from its
own source).

`--update` refuses to run without `--yes`, for the same reason `--deploy`
does: it changes a live site.

## What never changes

Your brand — `brands/<id>/brand.json`, `theme.css`, icons — your presentation
and deployment config, and your
content are never touched by an update, by construction: the updater only
ever bumps the pinned engine package version and calls your platform's own
build/deploy commands. There is no code path in the update mechanism that
writes to your brand folder.

When a new engine release adds a UI feature, it always ships with a
sensible default look, so your existing theme keeps working exactly as
before. If the release notes mention a new token your theme *could* adopt,
that's always optional, on your own schedule — never required to take the
update.

## Skipping a release

Nothing to do. If you don't run the command, nothing happens — no PR to
close, no opt-out step. The admin portal will keep showing you the newer
version is available until you decide to take it (or a later one
supersedes it).

## Before you update, on Postgres

Cloudflare D1 has time-travel recovery built in, so a bad migration is
recoverable without preparation. Azure Postgres has no in-place undo, so
take a snapshot first if the data matters to you:

```bash
pg_dump "$DATABASE_URL" --format=custom --file="pre-update-$(date +%Y%m%d%H%M%S).dump"
```

`DATABASE_URL` is an app setting on the Web App — read it with
`az webapp config appsettings list`. This is a deliberate manual step
rather than something the installer does silently: where your database
backup goes is your decision, not the installer's.

## Rolling back

Re-pin the previous engine version in `package.json` (the update pins an
exact version, so the old one is right there in your git history), then
re-run the same `--update --yes` command — it will install exactly what's
pinned. Restore the database from your snapshot if a migration was
involved: on Azure, from the `pg_dump` above; on Cloudflare, with D1's
time-travel recovery.

## Running an update from CI instead

Nothing stops you: the update command is an ordinary Node script, so a
GitHub Actions job (or any other runner) can run it with a platform
credential held as a CI secret. That's a legitimate choice if you already
run CI — but it is *your* CI holding *your* platform credential, on a
runner you control. It is not something the deployed site can trigger, and
StoryLark no longer ships a workflow for it. The default path, and the one
these docs describe, is the command above.

## One-click updates (optional)

If you want a button, you can have one. It is **off unless you turn it on**,
it is per-deployment, and it is revocable in one step.

### What it does

Press **Install update** in `/admin` and the site:

1. downloads the **prebuilt engine** for that release — a single zip
   attached to the GitHub Release, downloaded with no credentials because
   it is a public file;
2. checks it against the `sha256` published beside it, and refuses to go on
   if it does not match;
3. checks the package's own per-file checksums, and refuses any package
   that contains a `brand.json`, `theme.css`, `presentation.json`,
   `manifest.webmanifest` or `icons/` — those are yours, and a release
   artifact carrying them would be somebody else's identity;
4. applies any pending database migrations;
5. redeploys itself through your own platform.

No build runs anywhere. That is the difference from the old button, and it
is only possible because the engine no longer has your brand compiled into
it — the same prebuilt zip is correct for every StoryLark deployment on a
given version, and your `brand.json`, `theme.css`, `presentation.json` and
icons are carried across the update untouched.

### Turning it on

```bash
# Cloudflare
node platforms/cloudflare/install.mjs --enable-one-click --yes

# Azure
node platforms/azure/install.mjs --enable-one-click --yes
```

**On Cloudflare** it asks you for a Cloudflare API token that *you* create,
with one permission — `Account | Workers Scripts | Edit` — and stores it as
a Worker secret. It does not mint one for you on purpose: a credential you
did not consciously create is a credential you will never think to revoke.

**On Azure it stores nothing at all.** App Service can give the running app
its own identity, and Kudu — the deployment engine `az webapp deploy`
already drives — accepts it. So the installer turns on a system-assigned
managed identity and grants it **Website Contributor on that one Web App**.
There is no secret to leak and none to rotate; the permission is a role
assignment you can see and delete in the Azure portal.

### Turning it off

```bash
node platforms/<cloudflare|azure>/install.mjs --disable-one-click --yes
```

On Cloudflare, revoking the token at
<https://dash.cloudflare.com/profile/api-tokens> is enough on its own. On
Azure, deleting the role assignment is. Either way the button disappears on
the next page load and nothing else about your site changes — `/admin` goes
back to showing the command.

### What it deliberately cannot do

- **It cannot be triggered without a browser.** The route takes an admin
  *session*, not the `ADMIN_KEY` header. The click is the approval; a shared
  key sitting in an environment file is not a click.
- **It cannot change your configuration.** On Cloudflare the update uses
  Cloudflare's "put script content" endpoint, which leaves bindings, vars,
  secrets, routes and cron triggers alone. Your D1 database, your R2 bucket
  and your custom domain are not this feature's business.
- **It cannot touch your brand or content.** Both are excluded by
  construction, not by care: the artifact format rejects a package that
  contains brand files, and the updater re-uploads your own copies as part
  of the deploy.
- **It cannot run without you.** Nothing auto-applies. There is no schedule,
  no "install automatically" setting, and no way for anyone outside your
  admin accounts to start it.

### If it fails

The portal shows the log and the platform's own error. Take the update with
the command instead — that path needs none of this and is always available.

### Why the old button was removed and this one is different

Earlier versions of StoryLark put a button in `/admin` that dispatched a
GitHub Actions workflow, which meant the deployment had to store a GitHub
repo name and a token with permission to run workflows. That made a GitHub
account a prerequisite for owning a reading app and left a standing
build-and-deploy credential inside it. It was removed outright.

This button asks nobody to rebuild anything. It downloads a file, checks it,
and hands it to the platform you are already paying for, using a permission
you granted to your own deployment and can withdraw at any time.
