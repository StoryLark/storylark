# Updating

How your deployed site receives platform updates — from the operator's
chair, not the code's.

## Nothing updates without your click

StoryLark never updates itself silently. There is no background process
that changes what's running without you approving it first.

## How you find out

Two ways:

1. **Check yourself** — open `/admin` on your site. The "Platform update"
   card shows what you're running versus the latest release, with a link to
   the release notes.
2. **Get told** — if you've set `ADMIN_EMAIL` and `RESEND_API_KEY`, a daily
   check emails you when a new release exists. You never have to remember
   to look. See [`admin-guide.md`](admin-guide.md) for setting these up.

## The click

When you're ready, click **Install update** in `/admin`. That click *is*
the approval — here's exactly what happens next:

1. Your site's `self-update.yml` (a GitHub Actions workflow, already in
   your repo) starts running.
2. It bumps the pinned engine version (`storylark-core` / `storylark-worker`
   in `package.json`) to the latest.
3. On the Azure path, it takes a database snapshot before touching
   anything — Postgres has no built-in undo for a bad migration the way
   Cloudflare D1's time-travel recovery does, so this workflow makes its
   own safety net. (On Cloudflare, D1's own point-in-time recovery covers
   this.)
4. It applies any pending database migrations.
5. It rebuilds the app and redeploys.

A few minutes later, you're on the new version. The admin portal's status
card reflects it immediately after.

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

Nothing to do — if you don't click Install, nothing happens. There's no
PR to close, no opt-out step; the admin portal will just keep showing you
the newer version is available until you decide to take it (or a later one
supersedes it).

## Rolling back

If an update goes wrong: the Azure path's pre-migration database snapshot
is uploaded as a workflow artifact (30-day retention) — restore from it and
redeploy the previous pinned version. On Cloudflare, use D1's time-travel
recovery to restore the database, and redeploy the previous version the
same way. Either way, `git revert` the version bump in `package.json` and
re-run the deploy step is the fastest path back to exactly what you had.

## Setting this up

Requires two secrets on your deployment: `GITHUB_REPO` (`owner/repo` for
your site's own repo) and `GITHUB_DEPLOY_TOKEN` (a fine-grained PAT with
Actions:write on that repo — Contents:write too if you also want the admin
portal's story upload). Without them, `/admin` still shows update status,
but the Install button is disabled with an explanation. See
[`deploy-your-own.md`](deploy-your-own.md) / [`deploy-azure.md`](deploy-azure.md)
for the full secrets list.
