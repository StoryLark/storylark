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

**Platform update** — current version vs. latest, a link to release notes,
and the command that performs the update, ready to copy. There is no
install button, on purpose: updates run from your own machine with the
platform credentials you already have, so this deployment stores nothing
that could deploy on your behalf. See [`updating.md`](updating.md) for the
full flow.

**Stories** (or **Books**, depending on how your library is arranged) — the
content manager. Browse what's published, open any chapter, edit it as plain
markdown with a live preview, and save. Covered in full below.

**Brand & themes** — what your site looks like and what it calls itself.
Install a theme package, edit your brand's own details, see every version
you've installed, and roll back. Covered below.

**Publish a story** — book id, title, author, and markdown text. See
[`publishing-stories.md`](publishing-stories.md) for the full picture,
including why this is text-only today and how narration gets added.

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

**Narration doesn't happen here.** Text publishes immediately, but this
deployment can't generate speech — that needs the publish pipeline. So after a
text edit the chapter is marked *audio out of date* until you run:

```bash
node packages/pipeline/publish.mjs --brand <id> --source <path> --pull
```

`--pull` matters: it brings your portal edits back into your working copy
first, so publishing doesn't overwrite them. See
[`content-pipeline.md`](content-pipeline.md).

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

Both write the same thing, so both appear in the same version history, roll back
the same way, and can be **downloaded as a package**.

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
- **Update card says you're up to date** — you are; it read the version out
  of the running deployment and compared it against npm.
- **Status shows `—` for book/chapter counts** — the manifest was
  unreachable when the page loaded; try refreshing.
- **Story upload says "committed but publishing failed to start"** — the
  markdown file made it into your repo, but the GitHub Actions dispatch
  didn't fire. Check your repo's Actions tab and re-run `publish.yml`
  manually if needed.
