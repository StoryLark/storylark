# Admin Guide

Running your deployed StoryLark site from `/admin` — the operator's portal.

The portal is a **standalone page**, not a screen inside the reader app: its
own document, its own bundle, no reader or player code, and deliberately
outside the installable PWA — nothing about it is precached, so what you see
is always live, never a cached copy from before your last update. Readers
never download any of it, and nothing in the reader links to it. See
[`design/standalone-admin.md`](design/standalone-admin.md) for how that's
built and routed.

## Getting in

The admin portal uses a normal account — the same email and password any
reader on your site would have, just flagged as an operator. There's no
shared key to type in and no separate login system to remember.

### First time: the setup link

At the end of a successful deploy, the installer prints two things:

1. **A one-time setup link** — `https://<your-app-origin>/admin?setup=…`.
   Open it and choose the email and password you'll use to sign in from now
   on. The link works once and expires an hour after it's printed.
2. **Ten recovery codes** — `XXXX-XXXX-XXXX` each. This is the only time
   they're ever shown. Put them in your password manager, not in the
   terminal scrollback you're about to close.

That's it. From then on, `https://<your-app-origin>/admin` is an ordinary
email-and-password sign-in.

If you missed the output, or the installer couldn't reach the site in time
to print it, mint a fresh link and a fresh set of codes yourself:

```
curl -X POST https://<your-app-origin>/api/admin/setup/reset \
  -H "x-admin-key: <your ADMIN_KEY>"
```

### Day to day

Open `/admin` and sign in with that email and password. The session is a
normal `httpOnly` cookie, same as the reader side — no key is stored in your
browser, and **Sign out** ends the session server-side.

If you sign in with an account that isn't an operator, the portal says so
plainly rather than showing you an empty page.

### Locked out? Three ways back in

**1. Forgot-password email.** The fastest door, and nothing special: your
admin account is a regular account, so the standard reset works on it. Use
**Forgot password?** on the sign-in form (it hands off to the same reset
flow readers use), get the 6-digit code by email, pick a new password.
Needs `RESEND_API_KEY` and `MAIL_FROM` configured on the deployment and
access to that mailbox.

**2. A recovery code.** Choose **Use a recovery code instead** on the
sign-in form, then enter your admin email, one of the codes from install
time, and a new password. Each code works once. This door has no runtime
dependencies at all — no mail provider, no CLI, no cloud console — so it's
the one that still works when everything else is having a bad day. When
you're running low, mint a fresh batch with the `curl` above; doing so
invalidates any older codes.

**3. The deployment's `ADMIN_KEY`.** Last resort, for when the password and
the recovery codes are both gone. Anyone with access to this deployment's
configuration (Azure portal, `wrangler secret`) can read `ADMIN_KEY` and run
the `curl` above to mint a brand-new setup link and a new set of recovery
codes. This grants no new power: someone who can change your deployment's
configuration can already redeploy the whole application.

`ADMIN_KEY` is therefore no longer a login. Its entire remaining job is
minting setup links, plus authenticating the publish pipeline's push
notification call (`POST /api/admin/publish`), which runs headless in CI and
so can't hold a session cookie.

## What you'll see

**Status** — your brand id, the running engine version, how many books and
chapters are published, and how many devices are subscribed to push
notifications. Book/chapter counts come from the public manifest; if it's
briefly unreachable, they show as `—` rather than breaking the page.

**Platform update** — the installed engine and Worker versions, the latest
release, release notes, and a permanent **Check for updates** button. When an
update is available, **Update now** downloads a checksum-verified prebuilt
engine, applies additive migrations, and switches atomically without touching
your brand, theme, presentation, or content. Releases that also change the API
server use the deployment permission provisioned by the installer. A missing
self-update permission is a fault (or an explicit `SELF_UPDATE=off` opt-out),
not the normal state. The installer command remains the documented fallback.
See [`updating.md`](updating.md).

**Stories & Books** — the content manager for standalone stories,
multi-chapter books, and mixed libraries. Browse what's published, open a
chapter, edit it as plain markdown with a live preview, or remove content with
typed confirmation. The first-use screen offers four distinct doors: **Upload
markdown**, **Connect a repo**, **CMS / API**, and **Publish with narration
(GitHub)**. Covered in full below.

**Narration** — the bulk narration queue: which chapters are waiting for
audio, which are being narrated, which failed and why, and a real time
estimate once anything has finished. Covered below.

**Brand & themes** — what your site looks like and what it calls itself.
Install a theme package, edit your brand's own details, see **Theme version
history**, and roll back. A history entry such as `Theme: Holdfast Reader
v1.0.0+1` identifies a theme package revision; it is not the StoryLark engine
version. Engine versions live under Platform update / System. Covered below.

**Publish content** — upload Markdown directly, use the GitHub-backed publisher
for narration, connect a repository, or push from a CMS through the content
API. See [`publishing-stories.md`](publishing-stories.md).

**Connections** — saved source connections owned by this deployment. The
repository panel appears only after an administrator completes **Connect a
repo** and StoryLark stores that validated connection. A GitHub Actions job or
other publisher can read a repository and push the result through the content
API, but that is an external publishing pipeline, not an Admin repo connection;
it therefore does not create repository details on this screen.

This distinction is visible in content ownership too: an Admin repo connection
records repo mode and supports **Sync now**, scheduled sync, webhook status,
and per-file results. Content pushed by Actions or a CMS records API/external
ownership and is managed at that source. Do not create a fake connection row
just to make the panel appear. For a private repo, configure a durable,
repository-scoped read credential through the connection flow; a short-lived
GitHub App installation token is not suitable as the saved sync credential.

## Editing your content

The portal lists your library the way it's actually arranged: a single work
shows its books and then the chapters inside one, while a library of short
stories shows the stories and opens straight into the one you pick.

What you get on a chapter:

- **A plain markdown editor with a live preview.** Not a rich-text editor, on
  purpose: a WYSIWYG needs a two-way conversion, and that conversion is a
  reliable source of silent content corruption. The preview is rendered by the
  same code that publishes, so what you see is what will land.
- **Three ways to change the text** — type, paste, or upload a `.md` file. All
  three mean the same thing, so they're the same operation underneath.
- **Download .md** — the mirror of upload. Pull the chapter into your own
  editor and put it back. This is the escape hatch when a browser textarea is
  the wrong tool.
- **Insert image** — uploads the file and inserts the markdown reference at
  your cursor. You never type a URL, and you never have to know where storage
  lives. You'll be asked for alt text, which is what a reader who can't see the
  image gets.
- **History with one-click revert** — the last five versions of the text are
  kept (the live one is never dropped). A revert is an ordinary save: it puts
  the old text back and *adds* to the history rather than rewinding it, so
  reverting a revert works.
- **"This is a correction"** — ticked by default when you're editing something
  that already exists. Readers get the new text either way; ticked, nobody is
  notified. Untick it only when this is genuinely new writing worth waking a
  phone for.
- **Delete with typed confirmation** — available for content this deployment
  owns. Synced or API-managed content stays read-only and must be removed at its
  source, then published or synced again.

**Narration doesn't happen here.** Text publishes immediately, but this
deployment can't generate speech — that needs the publish pipeline. So after a
text edit the chapter is marked *audio out of date* until you run:

```bash
npx storylark-publish --brand <id> --source <path> --pull
```

`--pull` matters: it brings your portal edits back into your working copy
first, so publishing doesn't overwrite them. See
[`content-pipeline.md`](content-pipeline.md).

Every edit that leaves audio out of date is also added to the **Narration**
queue automatically, so if a narration worker is already running on a
schedule you may not need to run anything by hand — see the Narration section
below.

Book-level details — title, author, description and the cover image — are on
the book itself, above its chapters.

### Content you can see but can't edit

If a book or chapter is labelled **synced**, its source of truth is somewhere
else — a git repository of markdown, or your own content system — and StoryLark
holds a copy. Opening it gives you the text, the preview, the download and the
history, but no editor and a **Managed externally** notice naming the source and
linking to it.

That isn't a permissions problem, and it's not something to work around: a change
saved here would be overwritten the next time the sync runs. Edit it where it
lives, then re-sync. The rule is *whoever owns the content owns the edit button*,
and it's what keeps this deployment and your real catalogue from quietly becoming
two different libraries. Everything you wrote here, and everything you published
from your own markdown, stays fully editable as normal — the two can sit side by
side. See [`content-sync.md`](content-sync.md).

## Narration

**Stories & Books** covers the text. Getting audio for it is a separate step, and the
**Narration** card is where you watch it happen.

Saving a chapter, reverting one, a push over the [content API](content-api.md),
or a bulk import all leave chapters whose audio doesn't match their words yet —
after a fifty-story import, that's the whole library at once. Rather than a
button that spins and lies, the card shows exactly what's owed: a queue of
**jobs**, one per chapter, moving

```
waiting → being narrated → done
                        ↘ failed → (retry)
```

Waiting/being narrated/done/failed counts sit at the top, followed by a running
total of characters still to narrate and, once anything has finished on this
deployment, a real time estimate measured from its own completed jobs — never a
guess offered before the first one lands. Each job below shows which chapter it
is, how long it's been running or actually took to narrate, and — for a failed
job — the exact reason, with a **Retry** button next to it. A pending job can be
**Cancelled**; a running one has to finish or fail first.

**Neither platform this engine deploys to can generate the audio itself.** A
Cloudflare Worker has no filesystem for the narration model's weights, no native
ONNX runtime, and a CPU budget in seconds against a job measured in minutes. The
Node/Azure entry (`platforms/azure/server.mjs`) could technically host a model
but deliberately doesn't — its dependencies are the web framework, the Postgres
driver and the blob client. Text-to-speech, forced alignment and audio stitching
live in `packages/pipeline`, alongside `ffmpeg` and the storage credentials,
which is where narration has always actually happened. So the deployment's job
is to hold the queue; draining it means running, wherever your publishing
already runs (a laptop, a scheduled GitHub Actions job, a box in the corner):

```bash
npx storylark-narrate --brand <brand-id>
```

The card shows this exact command, in the deployment's own words, rather than a
sentence hard-coded in the browser bundle — so it stays true the day an
in-deployment narrator becomes possible without anyone having to remember to
update it.

See [`narration-queue.md`](narration-queue.md) for the full detail: every job
state, the HTTP surface a worker uses to claim and report on jobs, how the time
estimate is measured, and how an operator gets emailed when a batch finishes.

## Changing how your site looks

The **Brand & themes** card changes your site's identity and look on a live
deployment. No rebuild, no redeploy, no repo — the change is live on the next
page load.

Two ways in, deliberately:

- **Edit brand details** — the form. Your app name, library name, tagline,
  author, the two manifest colours, light or dark by default, and a font per
  role picked from the set your build shipped. This is how you change one thing.
- **Install a theme package** — a `.storylark-theme.zip` holding `brand.json`,
  `theme.css`, `icons/` and optionally `presentation.json`. This is how you
  install a whole look, move one between sites, or take one from the gallery.
  Build one with `npm run package-theme`; see
  [`build-your-own-theme.md`](build-your-own-theme.md).

Both write the same thing, so both appear in **Theme version history**, roll
back the same way, and can be **downloaded as a package**. The displayed name,
version, date, and actor describe the installed theme package or brand edit,
not the StoryLark engine release.

**A package is checked completely before anything changes.** Missing icons, an
icon at the wrong size, missing design tokens, a `contractVersion` this engine
doesn't read — the upload is refused with the full list of what to fix, and your
site is left exactly as it was. A bad package is never applied in part. Use
**Check it first** to run those same checks without installing anything.

**Rolling back.** The last five versions are kept, and the live one is never
aged out. "Roll back to this" restores exactly the bytes that were installed.
"Revert to the built-in brand" stops overriding altogether and puts back the
brand your build shipped with — the history survives, so you can roll forward
again.

**From a terminal**, the same operations, against the same endpoint:

```sh
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> <package.zip>
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> --list
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> --rollback previous
npm run import-theme -- --url https://your.site --key <ADMIN_KEY> --revert
```

**Two things worth knowing.**

- Installing a theme needs the same writable storage content editing needs (an
  R2 bucket on Cloudflare, `AZURE_STORAGE_CONNECTION_STRING` or
  `STORYLARK_LOCAL_CONTENT` on Node). Without one the card says so.
- Anyone who has **installed** your site to their home screen keeps the previous
  name and icon until they reinstall it — the operating system owns the copy of
  the manifest it installed with. Everything inside the app updates normally.

## Turning features on

Story upload — and only story upload — needs two secrets, because it
commits the markdown to your site's repo:

| Secret | What it's for |
|---|---|
| `GITHUB_REPO` | `owner/repo` — your site's own GitHub repo |
| `GITHUB_DEPLOY_TOKEN` | A fine-grained PAT scoped to just that repo, with Contents:write (for the commit) and Actions:write (to start `publish.yml`) |

Content editing needs writable content storage. On Cloudflare you already have
it: the R2 bucket declared in `wrangler.jsonc` is the same storage the portal
writes through, so there's nothing to configure. On a Node host (Azure App
Service, a container) set one of these:

| Setting | What it's for |
|---|---|
| `AZURE_STORAGE_CONNECTION_STRING` | Azure Blob. The container defaults to `<brand>-content`; override with `CONTENT_CONTAINER`. |
| `STORYLARK_LOCAL_CONTENT` | A directory on disk holding the published content. Useful for local development and for a single-machine deploy with no object store. |
| `CONTENT_REVISIONS` | How many text revisions to keep per chapter. Default 5. |
| `THEME_VERSIONS` | How many installed theme versions to keep for rollback. Default 5. |
| `CONTENT_MAX_UPLOAD_BYTES` | Ceiling for an uploaded image. Default 8MB. |

Without any of them the site serves content exactly as before, and the content
manager says so plainly instead of failing in a confusing way.

Without these, the portal still loads and the story upload form explains
that it isn't configured rather than silently failing. Nothing else in the
portal depends on them — in particular, **platform updates do not**, and
never will again (see [`updating.md`](updating.md)). Publishing from the
CLI doesn't need them either.

For proactive email notifications when a new release exists (instead of
having to check the portal), also set `ADMIN_EMAIL` and `RESEND_API_KEY` —
see [`updating.md`](updating.md).

## Under the hood, briefly

Nothing in the admin portal reimplements logic that lives elsewhere. The
publish form commits to your repo and dispatches `publish.yml`, which runs
the exact same `packages/pipeline/publish.mjs` the CLI uses. The update
card hands you the exact installer command the CLI documents. The portal is
a front door to the real mechanisms, not a second copy of them — so there's
never a question of which one is "really" correct.

## If something's not working

- **"not_configured" errors** — the two GitHub secrets above aren't set on
  this deployment. They affect story upload only.
- **Update card says you're up to date** — it read the running versions and
  compared them against npm. Use **Check for updates** to refresh the result.
- **Update now is unavailable or reports missing permission** — self-update
  was explicitly disabled or the deployment was not provisioned correctly.
  Run the platform installer update/repair path described in
  [`updating.md`](updating.md); do not treat this as the expected configuration.
- **Connections has no repository details** — no Admin repo connection is
  stored. A GitHub Actions workflow that publishes repository content through
  the API does not populate this panel; configure **Connect a repo** if you want
  StoryLark itself to own and display the connection.
- **Status shows `—` for book/chapter counts** — the manifest was
  unreachable when the page loaded; try refreshing.
- **Story upload says "committed but publishing failed to start"** — the
  markdown file made it into your repo, but the GitHub Actions dispatch
  didn't fire. Check your repo's Actions tab and re-run `publish.yml`
  manually if needed.
