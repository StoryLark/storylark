# Deploy Your Own

StoryLark is built to be deployed **once per brand from the same codebase**: one
Cloudflare Worker, one D1 database, one R2 bucket per brand. This guide stands up
a new branded site end to end.

> For the exhaustive reference — every binding, environment variable and secret
> the worker reads on either platform, migrations, cron triggers, and custom
> domains — see [`deploy-worker.md`](deploy-worker.md). This page is the
> step-by-step walkthrough; that page is what to check when something's missing.

> Everything below uses **placeholders** — `<your-...>`, `example.com`,
> `00000000-...`. Never commit real account IDs, database IDs, domains, or
> secrets. The base brand's `wrangler.jsonc` env ships with placeholder IDs on
> purpose; fill in your own only in your deployment, and keep secrets out of the
> repo (`wrangler secret put`, below).

## 1. Create your brand

Copy the base brand and give it a new id:

```
cp -r brands/storylark brands/<your-id>
```

Edit `brands/<your-id>/brand.json` (identity), `presentation/<your-id>/presentation.json`
(layout, nouns), `deployment/<your-id>/deployment.json` (origins, TTS, VAPID public key) and
`brands/<your-id>/theme.css` (colors + fonts). The full field-by-field reference
is in [`build-your-own-theme.md`](build-your-own-theme.md). At minimum, set:

- `id` — must match the folder name and the `--mode` you build with.
- `appName`, `name`, `shortName`, `tagline`, `author`.
- `appOrigin` — where the app is served (e.g. `https://app.example.com`).
- `contentOrigin` — **optional.** Leave it `""` (same-origin, the default for a
  new deployment) and the Worker serves content out of the R2 bucket itself at
  `/manifest.json` and `/books/*` — no content domain, no DNS setup. Set a URL
  (e.g. `https://content.example.com`) only to serve content from its own
  domain — see step 3 for when that's worth it.
- `themeColor` / `backgroundColor` — must match your theme's paper color.
- `layout` and `nouns` — see [`build-your-own-presentation.md`](build-your-own-presentation.md).

### Icons

The manifest references three PNGs under `brands/<your-id>/assets/icons/`:

| File | Size | Purpose |
|---|---|---|
| `icon-192.png` | 192×192 | Standard |
| `icon-512.png` | 512×512 | Standard |
| `icon-maskable-512.png` | 512×512 | Maskable (safe-zone padded) |

Drop in your own artwork, or generate neutral placeholder icons in your brand
colors:

```
node packages/pipeline/gen-icons.mjs --brand <your-id>
```

(The base brand also carries `favicon.svg`, `favicon-32.png`, `favicon-180.png`,
and a `logo.svg` — supply your own equivalents if your HTML references them.)

## 2. Add a Wrangler env for the brand

`wrangler.jsonc` defines **one env per brand**, selected with `--env`. Copy the
`storylark` block, rename it to `<your-id>`, and fill in your own resources:

```jsonc
"env": {
  "<your-id>": {
    "name": "<your-id>",
    "routes": [{ "pattern": "app.example.com", "custom_domain": true }],
    "d1_databases": [
      {
        "binding": "DB",
        "database_name": "<your-id>",
        "database_id": "<your-d1-database-id>",
        "migrations_dir": "packages/worker/migrations"
      }
    ],
    "r2_buckets": [
      { "binding": "CONTENT", "bucket_name": "<your-id>-content" }
    ],
    "vars": {
      "BRAND": "<your-id>",
      "APP_ORIGIN": "https://app.example.com",
      // "" = same-origin (no content domain needed). Or e.g. "https://content.example.com".
      "CONTENT_ORIGIN": "",
      "MAIL_FROM": "Your App <noreply@example.com>",
      "APP_NAME": "Your App"
    }
  }
}
```

The Worker serves `app/dist` as static assets, with SPA fallback for anything
that isn't a file. `run_worker_first` sends `/api/*`, navigations, `/admin`,
`/sw.js`, `/theme.css`, `manifest.webmanifest` and `/icons/*` through the
Worker — so it can stamp this deployment's live origins, VAPID key, brand and
presentation into them on the way out (see below), and so an installed theme
package can replace the icons — while `/assets/*`, the hashed JS, CSS and fonts
that are the bulk of the site, is served straight off the asset router with no
Worker invocation.

### Changing config after deploy

`APP_ORIGIN`, `CONTENT_ORIGIN`, `VAPID_PUBLIC_KEY` and the optional `TTS_*`
vars are read from the environment on every request and injected into the
document, so changing them in `wrangler.jsonc` (or the dashboard) and
redeploying the Worker is enough — **no site rebuild required**. The values in
`deployment/<id>/deployment.json` are the fallback a build carries for contexts
that have no server to inject: `vite dev`, `vite preview`, plain static
hosting.

### Changing your brand after deploy

Same idea, different source. `dist/brand.json` and `dist/theme.css` are read
from the deployed assets on every request, so replacing those two files and
uploading the assets changes the site's name, colours, fonts and PWA manifest —
again **no site rebuild**, no new JavaScript, no hashed asset touched. See
[Changing your brand without rebuilding](build-your-own-theme.md#changing-your-brand-without-rebuilding)
for the full list of what does and doesn't follow, and
[the design note](design/runtime-brand.md) for how it works.

### Rearranging the app after deploy

Same again, third source. `dist/presentation.json` is read from the deployed
assets on every request, so replacing that one file changes the tab bar, the
Home sections, the shelf's sorting and grouping, cover shape, the reader and
player defaults, which settings readers are offered and the empty-state copy —
**no site rebuild**, and on the Azure node server not even a restart. Anything
the file does not state takes a core default, permanently, so the file only ever
has to contain the parts you actually want to change. See
[Build your own presentation](build-your-own-presentation.md) for every key and
[the design note](design/presentation-contract.md) for how it works.

## 3. Provision Cloudflare resources

Authenticate once (`npx wrangler login`), then create the per-brand resources.

**D1 database** — create it, copy the returned `database_id` into your env's
`database_id`, then apply the migrations in `packages/worker/migrations/`:

```
npx wrangler d1 create <your-id>
npx wrangler d1 migrations apply <your-id> --env <your-id> --remote
```

**R2 bucket** — the content bucket is named `<your-id>-content` (the publish
pipeline derives this name from the brand id):

```
npx wrangler r2 bucket create <your-id>-content
```

**No custom domain is needed.** With `contentOrigin`/`CONTENT_ORIGIN` left
empty (the default), the Worker serves the bucket's content itself, same-origin:
`contentUrl()` builds root-relative URLs and `GET /manifest.json` and
`GET /books/*` answer straight out of the `CONTENT` binding, with the same
cache-control the pipeline wrote each object with. A fresh deployment loads
content the moment `publish.mjs` finishes — nothing to configure.

**Optionally**, serve content from its own domain instead: set
`contentOrigin`/`CONTENT_ORIGIN` to e.g. `https://content.example.com` and
attach an R2 **custom domain** to the bucket. The pipeline uploads objects at
the bucket root, and an R2 custom domain serves the bucket root at the domain
root — so `content.example.com/manifest.json` maps to the `manifest.json`
object. Why bother: content requests then bypass the Worker entirely — zero
Worker invocations for chapter JSON, audio and art, which matters for
free-tier headroom on a high-traffic site, and it lets you put a different CDN
or caching policy in front of content than in front of the app. (See
[`architecture.md`](architecture.md).) The trade-off is real DNS work: R2
custom domains require the domain to be in your Cloudflare zone. Same-origin
costs one Worker invocation per content fetch — mostly absorbed in practice by
the service worker's aggressive content caching and the year-long
`Cache-Control` on hashed objects.

## 4. Set secrets

These are **Worker secrets**, never committed. Set the ones you need per env:

```
npx wrangler secret put VAPID_PUBLIC_KEY   --env <your-id>
npx wrangler secret put VAPID_PRIVATE_KEY  --env <your-id>
npx wrangler secret put ADMIN_KEY          --env <your-id>
npx wrangler secret put RESEND_API_KEY     --env <your-id>
npx wrangler secret put GOOGLE_CLIENT_ID   --env <your-id>
npx wrangler secret put GOOGLE_CLIENT_SECRET --env <your-id>
```

| Secret | Needed for | Notes |
|---|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web push | Generate with `node packages/pipeline/gen-vapid.mjs`. Put the **public** key in `deployment/<id>/deployment.json` `vapidPublicKey` *and* the Worker secret; the **private** key is Worker-only. See [`push.md`](push.md). |
| `ADMIN_KEY` | Minting admin setup links; `POST /api/admin/publish` | **Not** the admin login — `/admin` is gated by a normal email+password account (see [`admin-guide.md`](admin-guide.md)). This secret mints the first admin setup link and the printed recovery codes, and the publish pipeline sends it as `X-Admin-Key` to fire push notifications. Without it, publishing still works (it just skips the notify step) but you have no way to create the first operator account. |
| `RESEND_API_KEY` | Magic-link email | Only if you enable the (currently dormant) magic-link path. See [`auth.md`](auth.md). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in | Only if you enable the (currently dormant) Google path. |
| `GITHUB_REPO` / `GITHUB_DEPLOY_TOKEN` | Admin-portal story upload only | `GITHUB_REPO` is `owner/repo` for your site's own repo; `GITHUB_DEPLOY_TOKEN` is a fine-grained PAT with Contents:write + Actions:write on just that repo. Without these, story upload from `/admin` is disabled and everything else is unaffected — see [`admin-guide.md`](admin-guide.md). **Engine updates do not use these**: they run from your machine with your own platform login, see [`updating.md`](updating.md). |
| `ADMIN_EMAIL` | Proactive update emails | With `RESEND_API_KEY` also set, the daily scheduled check (Cron Trigger — already in `wrangler.jsonc`) emails this address when a new release exists, so you hear about it without opening `/admin`. Without it, the daily check still runs but stays silent; `/admin` always shows the current status regardless. |

Password + passkey sign-in need **no** secrets.

## 5. Build and deploy

```
npm run build -w app -- --mode <your-id>
npx wrangler deploy --env <your-id>
```

The root `npm run deploy` is hardcoded to the `storylark` brand/env; for your own
brand, run the two commands above (or add a matching script to `package.json`).

## 6. Publish content

Your site boots as an empty shelf until you publish. Point the pipeline at your
content source and a parser you own:

```
node packages/pipeline/publish.mjs --brand <your-id> \
  --source <path-to-your-content> \
  --parser <path-to-your-parser.mjs>
```

Full pipeline reference, flags, and the parser contract:
[`content-pipeline.md`](content-pipeline.md).

## Free-tier note

The default architecture is tuned to fit Cloudflare + Azure Speech free tiers
(see the budget table in [`architecture.md`](architecture.md)). The publish
pipeline enforces a monthly TTS character budget with a hard stop; heavier usage
means moving off the free tiers.
