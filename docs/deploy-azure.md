# Deploy to Azure

StoryLark runs on Azure the same way it runs on Cloudflare: one deployment
per brand, from the same codebase. This guide provisions a branded site on
**Azure App Service**, **PostgreSQL Flexible Server**, and **Blob Storage**.

Full detail (env vars, publishing content, how the Azure path differs
internally) lives in [`platforms/azure/README.md`](../platforms/azure/README.md)
— this page is the quick path.

## What gets created

`platforms/azure/infra.bicep` provisions, per brand:

| Resource | Purpose |
|---|---|
| Azure App Service (Node 20, Always On) | Runs the app + API (`platforms/azure/server.mjs`) |
| PostgreSQL Flexible Server + database | Accounts, sessions, progress — the [database driver](../packages/worker/src/db/postgres.ts) |
| Storage Account + public Blob container | Published content — the [storage driver](../packages/pipeline/storage-azure.mjs) |

## Picking a region — check before you deploy, not after

**Not every Azure region works for every resource on every subscription.**
This isn't about which regions Azure offers in general — it's about what
*your specific subscription* is allowed to provision, which varies
per-subscription and can differ for each resource type independently. On
the subscription this was built and tested against, `eastus` turned out to
be blocked for **both** resources this template needs (Postgres Flexible
Server provisioning restricted; zero App Service B-series VM quota), while
`centralus` had neither problem. There's no way to know in advance which
region is open for *your* subscription — you have to check.

**Before setting `AZURE_LOCATION`, run both of these checks:**

1. Is PostgreSQL Flexible Server provisioning open in this region?
   ```
   az rest --method get --url "https://management.azure.com/subscriptions/<sub-id>/providers/Microsoft.DBforPostgreSQL/locations/<region>/capabilities?api-version=2025-08-01" --query "value[0].reason"
   ```
   An empty/null result means it's open. Any text back (e.g. "Provisioning
   is restricted in this region...") means it's blocked for your
   subscription — try a different region for this check.
2. Does this region have App Service compute quota for the SKU you want?
   ```
   az vm list-usage --location <region> --query "[?contains(localName, 'BS Family')]" -o table
   ```
   If `CurrentValue` equals `Limit` (often `0/0`), there's no quota here —
   either pick a different region or use the free `F1` tier
   (`APP_SERVICE_SKU=F1` in `install.env` — see the note on F1 below).

**If the two checks disagree** — say Postgres is open in `eastus` but App
Service quota is only open in `centralus` — you don't have to pick one
region for everything. `AZURE_LOCATION` covers App Service + Storage;
`DB_LOCATION` (defaults to `AZURE_LOCATION` if unset) covers Postgres
independently, so the database can live in a different region from
everything else. This template does that by design.

## Steps

1. **Fill the installer's env file:**
   ```
   cp platforms/azure/install.env.example platforms/azure/install.env
   ```
   Set `BRAND_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_LOCATION`, `DB_ADMIN_PASSWORD`
   — run the region checks above first. See `install.env.example` for the
   optional overrides (`DB_LOCATION`, `APP_SERVICE_SKU`, `BRAND`).
2. **Verify before provisioning anything** (creates nothing — checks your
   values, that you're logged into Azure, and that the infrastructure
   template compiles):
   ```
   cd platforms/azure && node install.mjs --verify
   ```
3. **Deploy** (creates real resources and real cost — confirm the plan
   with whoever approves cloud spend before running this). This one command
   does everything: provisions the infrastructure, applies the database
   schema, builds the app for your brand, and deploys the app code to the
   App Service.
   ```
   node install.mjs --deploy --yes
   ```
   It prints the live URL when done.
4. **Publish content** through Azure Blob instead of the Cloudflare default:
   ```
   node packages/pipeline/publish.mjs --brand <your-id> \
     --source <path-to-your-content> --storage azure-blob
   ```
   See [`authoring-stories.md`](authoring-stories.md) for the content format.

## Things that go wrong (found by actually deploying, not just reading the template)

- **`ParameterOutOfRange: 'Version' should be in: []` on the PostgreSQL
  resource, or `SubscriptionIsOverQuotaForSku` on the App Service Plan.**
  You skipped (or need to redo) the region checks above — see
  "Picking a region." Note on `F1`: the free tier doesn't support Always On
  (the template already handles this) and has a small daily compute quota
  that a crash-loop can burn through fast — it's a workaround for zero
  App Service quota, not the recommended target for anything beyond a
  quick test.
- **`extension "citext" is not allow-listed for users`** during migration.
  Already fixed in `infra.bicep` (an `azure.extensions` configuration
  resource allow-lists it) — if you're deploying against an existing server
  that predates this, allow-list it manually: `az postgres flexible-server
  parameter set --name azure.extensions --value citext`.

## Nothing about your brand changes

Switching platforms never touches `brands/<id>/` — the same theme,
presentation, and content publish identically whether the site runs on
Cloudflare or Azure. Only the infrastructure underneath differs.
