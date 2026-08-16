# Admin Guide

Running your deployed StoryLark site from `/admin` — the operator's portal.

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
and (when configured) an **Install update** button. See
[`updating.md`](updating.md) for exactly what happens when you click it.

**Publish a story** — book id, title, author, and markdown text. See
[`publishing-stories.md`](publishing-stories.md) for the full picture,
including why this is text-only today and how narration gets added.

## Turning features on

Both the update button and story upload need the same two secrets:

| Secret | What it's for |
|---|---|
| `GITHUB_REPO` | `owner/repo` — your site's own GitHub repo |
| `GITHUB_DEPLOY_TOKEN` | A fine-grained PAT scoped to just that repo, with Actions:write (for updates and publishing) and Contents:write (for story upload commits) |

Without these, the portal still loads and shows status/update information
read-only — the buttons that would trigger real actions are disabled with
an explanation rather than silently failing.

For proactive email notifications when a new release exists (instead of
having to check the portal), also set `ADMIN_EMAIL` and `RESEND_API_KEY` —
see [`updating.md`](updating.md).

## Under the hood, briefly

Nothing in the admin portal reimplements logic that lives elsewhere. The
update button dispatches your repo's own `self-update.yml`; the publish
form commits to your repo and dispatches `publish.yml`, which runs the
exact same `packages/pipeline/publish.mjs` the CLI uses. The portal is a
front door to the real mechanisms, not a second copy of them — so there's
never a question of which one is "really" correct.

## If something's not working

- **"not_configured" errors** — the two GitHub secrets above aren't set on
  this deployment.
- **Update button doesn't appear** — you're already on the latest version;
  that's the status card telling you there's nothing to install.
- **Status shows `—` for book/chapter counts** — the manifest was
  unreachable when the page loaded; try refreshing.
- **Story upload says "committed but publishing failed to start"** — the
  markdown file made it into your repo, but the GitHub Actions dispatch
  didn't fire. Check your repo's Actions tab and re-run `publish.yml`
  manually if needed.
