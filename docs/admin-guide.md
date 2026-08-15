# Admin Guide

Running your deployed StoryLark site from `/admin` — the operator's portal.

## Getting in

Open `https://<your-app-origin>/admin` and enter your deployment's admin
key (the `ADMIN_KEY` secret you set when deploying — see
[`deploy-your-own.md`](deploy-your-own.md) / [`deploy-azure.md`](deploy-azure.md)).
The key is stored in your browser's local storage on that device only; it's
sent as a header to this site's own `/api/admin/*` endpoints and nowhere
else. Sign out clears it.

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
