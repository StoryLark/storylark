# Updating

How your deployed site receives platform updates — from the operator's
chair, not the code's.

## Nothing updates without you running it

StoryLark never updates itself. There is no background process that changes
what's running, and — deliberately — **your deployment holds no credential
that could deploy on your behalf.** An installed reading app has no business
storing a GitHub token, a Cloudflare API token, or an Azure service
principal just so it can rebuild itself. It doesn't have one.

So updating has exactly two parts: the site tells you a new release exists,
and you run one command from the machine you deploy from.

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

Your brand — `brands/<id>/brand.json`, `theme.css`, icons — and your
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

## Why there's no "Install update" button

Earlier versions of StoryLark put a button in `/admin` that dispatched a
GitHub Actions workflow, which meant the deployment had to store a GitHub
repo name and a GitHub token with permission to run workflows. That was the
wrong trade: it made a GitHub account a prerequisite for owning a reading
app, and it left a standing deploy credential sitting inside the app.

A one-click in-portal update can come back later, but only on a design
where the deployment doesn't hold a build-and-deploy credential at all —
downloading a prebuilt release artifact rather than triggering a rebuild.
That work is tracked separately and isn't built yet. Until it is, the
command above is the whole story.
