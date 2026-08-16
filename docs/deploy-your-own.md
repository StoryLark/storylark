# Deploy Your Own

StoryLark is built to be deployed **once per brand from the same codebase**: one
Cloudflare Worker, one D1 database, one R2 bucket per brand. This guide stands up
a new branded site end to end.

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

Edit `brands/<your-id>/brand.json` (identity, origins, nouns, TTS) and
`brands/<your-id>/theme.css` (colors + fonts). The full field-by-field reference
is in [`build-your-own-theme.md`](build-your-own-theme.md). At minimum, set:

- `id` — must match the folder name and the `--mode` you build with.
- `appName`, `name`, `shortName`, `tagline`, `author`.
- `appOrigin` — where the app is served (e.g. `https://app.example.com`).
- `contentOrigin` — where R2 content is served (e.g. `https://content.example.com`).
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
      "CONTENT_ORIGIN": "https://content.example.com",
      "MAIL_FROM": "Your App <noreply@example.com>",
      "APP_NAME": "Your App"
    }
  }
}
```

The Worker serves `app/dist` as static assets and runs code only for `/api/*`
(`run_worker_first: ["/api/*"]`), with SPA fallback for everything else.

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

Attach an R2 **custom domain** so the bucket serves at your `contentOrigin`. The
pipeline uploads objects at the bucket root, and an R2 custom domain serves the
bucket root at the domain root — so `content.example.com/manifest.json` maps to
the `manifest.json` object. (See [`architecture.md`](architecture.md) for why
content bypasses the Worker.)

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
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web push | Generate with `node packages/pipeline/gen-vapid.mjs`. Put the **public** key in `brand.json` `vapidPublicKey` *and* the Worker secret; the **private** key is Worker-only. See [`push.md`](push.md). |
| `ADMIN_KEY` | Minting admin setup links; `POST /api/admin/publish` | **Not** the admin login — `/admin` is gated by a normal email+password account (see [`admin-guide.md`](admin-guide.md)). This secret mints the first admin setup link and the printed recovery codes, and the publish pipeline sends it as `X-Admin-Key` to fire push notifications. Without it, publishing still works (it just skips the notify step) but you have no way to create the first operator account. |
| `RESEND_API_KEY` | Magic-link email | Only if you enable the (currently dormant) magic-link path. See [`auth.md`](auth.md). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in | Only if you enable the (currently dormant) Google path. |
| `GITHUB_REPO` / `GITHUB_DEPLOY_TOKEN` | Self-update + admin-portal story upload | `GITHUB_REPO` is `owner/repo` for your site's own repo; `GITHUB_DEPLOY_TOKEN` is a fine-grained PAT with Actions:write + Contents:write on just that repo. Without these, `/admin` shows update status read-only and story upload is disabled — see [`updating.md`](updating.md) and [`admin-guide.md`](admin-guide.md). |
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
