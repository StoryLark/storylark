# Updating

How your deployed site receives platform updates — from the operator's
chair, not the code's.

## Nothing updates without you

StoryLark never updates itself. There is no background process that changes
what's running and no schedule that applies anything. What there is: the
site tells you a new release exists, and you take it — normally with one
button in `/admin`, always available as one command from your own machine.

The portal path is the same on every platform, because of how it works
underneath: the common release only changes the engine (the app your
readers load), and the site installs that into **its own storage** — the
same storage your content and themes already live in — then serves it from
there. No deploy API, no credential, no rebuild, identical code on
Cloudflare, Azure, and anything else that runs StoryLark.

## Part 1 — how you find out

Two ways, both free of credentials:

1. **Check yourself** — open `/admin` on your site. The "Platform update"
   card shows what you're running versus the latest release, with a link to
   the release notes, and a **Check for updates** button. The check is an
   unauthenticated read of the public npm registry.
2. **Get told** — if you've set `ADMIN_EMAIL` and `RESEND_API_KEY`, a daily
   check emails you when a new release exists. You never have to remember
   to look. See [`admin-guide.md`](admin-guide.md) for setting these up.

## Part 2 — Update now

Press **Update now** in `/admin` and the site:

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
5. switches the site over.

Step 5 is where the mechanism differs, and it is the site's business, not
yours:

- **Most releases** change only the engine. The files go into the
  deployment's own storage and the site serves them from there, starting
  with the next request. Nothing was redeployed, no platform API was
  called, and no credential exists that could have been. The switch is
  atomic — the documents and the hashed bundle flip together, and a reader
  mid-page-load on the old version keeps getting the old version's files
  until they reload.
- **Some releases** also change the API server (`storylark-worker`). A
  running server cannot replace its own code, so those redeploy through the
  platform — on Azure via the app's managed identity (no stored
  credential), on Cloudflare via an API token the installer set up when you
  deployed. Same button, same click, same result.

### Rolling back

The card keeps the last five installed engines and shows them with a
**Roll back to this** button. Rolling back restores exactly the bytes that
were installed — no download, no redeploy — and **Serve the built-in
engine instead** returns to whatever your deployment was built with. The
history survives both, so every move here is reversible.

If a release involved a database migration, note that rolling the engine
back does not undo the migration — migrations are written to be additive,
so old code under new schema is a supported state.

## The command — the floor that always works

From your copy of the site, on the machine you already deploy from:

```bash
# Cloudflare
node platforms/cloudflare/install.mjs --update --yes

# Azure
node platforms/azure/install.mjs --update --yes
```

The `/admin` card shows the right one for your platform, ready to copy —
always, whatever state the button is in. The button depends on a release
artifact existing and your platform having a good day; the command depends
on neither. It pulls the latest engine packages from npm (pinned exactly),
migrates, rebuilds with your brand untouched, and redeploys with the
platform login you already have. It installs nothing on the deployment,
stores no new secret, and creates no infrastructure. It is safe to run
repeatedly — including as the way to repair a deployment that has drifted.

`--update` refuses to run without `--yes`, for the same reason `--deploy`
does: it changes a live site.

## What never changes

Your brand — `brands/<id>/brand.json`, `theme.css`, icons — your
presentation and deployment config, and your content are never touched by
an update, **by construction, not by care**: the engine artifact format
*rejects* a package containing any brand file, and the installer re-checks
every path before it writes. There is no code path in the update mechanism
that can write your identity.

When a new engine release adds a UI feature, it always ships with a
sensible default look, so your existing theme keeps working exactly as
before.

## Skipping a release

Nothing to do. If you don't press the button, nothing happens — no PR to
close, no opt-out step. The portal keeps showing the newer version until
you take it (or a later one supersedes it).

## Before you update, on Postgres

Cloudflare D1 has time-travel recovery built in, so a bad migration is
recoverable without preparation. Azure Postgres has no in-place undo, so
take a snapshot first if the data matters to you:

```bash
pg_dump "$DATABASE_URL" --format=custom --file="pre-update-$(date +%Y%m%d%H%M%S).dump"
```

`DATABASE_URL` is an app setting on the Web App — read it with
`az webapp config appsettings list`. This is a deliberate manual step
rather than something the updater does silently: where your database
backup goes is your decision, not the installer's.

## Self-update for API-server releases — how it's set up, and how to turn it off

Engine releases need nothing: the storage the site writes is storage it
already has. The one thing that needs a permission is a release that
changes the API server, and the installer provisions that as part of a
normal `--deploy` (and `--update`), telling you exactly what it did:

- **Azure**: a system-assigned managed identity plus **Website Contributor
  on that one Web App**. No credential is stored anywhere; the app fetches
  a short-lived token at the moment of use. Revoke it by deleting the role
  assignment in the Azure portal, or run `--disable-one-click --yes`.
- **Cloudflare**: an API token stored as a Worker secret. When the
  installer authenticated with an API token of your own, it first tries to
  **mint a new one scoped to `Workers Scripts | Edit`** and stores that; if
  your token cannot create tokens (a common restriction), it stores the
  token it authenticated with and says so plainly. When you authenticated
  with `wrangler login` (OAuth), there is no raw token to store — that is a
  Cloudflare boundary — so the installer prints how to finish the job:
  `--enable-one-click --yes`, which asks you to paste a token you mint
  yourself. Revoke any of these at
  <https://dash.cloudflare.com/profile/api-tokens>.

Turning it off:

```bash
node platforms/<cloudflare|azure>/install.mjs --disable-one-click --yes
```

This also records `SELF_UPDATE=off` in `install.env`, so a later `--update`
does not silently re-enable it. With it off, the portal still updates
engine releases exactly as before; for a release that changes the API
server it says plainly that self-update is off for this deployment, how to
turn it back on, and shows the command that always works.

## What the button deliberately cannot do

- **It cannot be triggered without a browser.** The route takes an admin
  *session*, not the `ADMIN_KEY` header. The click is the approval; a
  shared key sitting in an environment file is not a click.
- **It cannot change your configuration.** Engine installs never touch the
  platform at all; server redeploys read back your bindings, vars and
  secrets and carry them forward unchanged. Your database, your storage
  and your custom domain are not this feature's business.
- **It cannot touch your brand or content.** Excluded by construction: the
  artifact format rejects a package that contains brand files, the engine
  store refuses to write one, and the server redeploy re-uploads your own
  copies.
- **It cannot run without you.** Nothing auto-applies. There is no
  schedule, no "install automatically" setting, and no way for anyone
  outside your admin accounts to start it.

## If it fails

The portal shows the log and the error. Every failure before the switch is
a pure no-op — download, checksum and package validation cannot touch the
deployment. Take the update with the command instead; that path needs none
of this and is always available.

## Running an update from CI instead

Nothing stops you: the update command is an ordinary Node script, so a CI
job can run it with a platform credential held as a CI secret. But it is
*your* CI holding *your* credential, on a runner you control — it is not
something the deployed site can trigger.
