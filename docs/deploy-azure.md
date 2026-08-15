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

## Steps

1. **Fill the installer's env file:**
   ```
   cp platforms/azure/install.env.example platforms/azure/install.env
   ```
   Set `BRAND_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_LOCATION`, `DB_ADMIN_PASSWORD`.
   See `install.env.example` for the optional overrides (`DB_LOCATION`,
   `APP_SERVICE_SKU`, `BRAND`) and when you need them — most likely
   `DB_LOCATION` (below).
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
  resource.** Not a version problem — Flexible Server provisioning is
  restricted to a subset of regions *per subscription*, independent of
  whether the region is generally available. Check with:
  ```
  az rest --method get --url "https://management.azure.com/subscriptions/<sub>/providers/Microsoft.DBforPostgreSQL/locations/<region>/capabilities?api-version=2025-08-01" --query "value[0].reason"
  ```
  An empty result means the region is open. If `AZURE_LOCATION` comes back
  restricted, set `DB_LOCATION` to an open one — the database can live in a
  different region from everything else.
- **`SubscriptionIsOverQuotaForSku`.** Some subscriptions have zero App
  Service B-series VM quota in a given region even though the SKU exists.
  Check with `az vm list-usage --location <region>`. If it's zero, either
  pick a region with quota or set `APP_SERVICE_SKU=F1` (free tier) — note
  F1 doesn't support Always On (the template already handles this) and has
  a small daily compute quota that a crash-loop can burn through fast.
- **`extension "citext" is not allow-listed for users`** during migration.
  Already fixed in `infra.bicep` (an `azure.extensions` configuration
  resource allow-lists it) — if you're deploying against an existing server
  that predates this, allow-list it manually: `az postgres flexible-server
  parameter set --name azure.extensions --value citext`.

## Nothing about your brand changes

Switching platforms never touches `brands/<id>/` — the same theme,
presentation, and content publish identically whether the site runs on
Cloudflare or Azure. Only the infrastructure underneath differs.
