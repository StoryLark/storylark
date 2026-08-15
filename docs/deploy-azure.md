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

1. **Build your brand:**
   ```
   npm run build -w app -- --mode <your-brand-id>
   ```
2. **Fill the installer's env file:**
   ```
   cp platforms/azure/install.env.example platforms/azure/install.env
   ```
   Set `BRAND_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_LOCATION`, `DB_ADMIN_PASSWORD`.
3. **Verify before provisioning anything** (creates nothing — checks your
   values, that you're logged into Azure, and that the infrastructure
   template compiles):
   ```
   cd platforms/azure && node install.mjs --verify
   ```
4. **Provision** (creates real resources and real cost — confirm the plan
   with whoever approves cloud spend before running this):
   ```
   node install.mjs --deploy --yes
   ```
5. **Configure the app:** copy `platforms/azure/.env.example` to `.env` and
   fill it from the deployment outputs (`az deployment group show` prints
   `webAppUrl`, `storageAccountName`, `postgresHost`).
6. **Apply the database schema:**
   ```
   npm run migrate
   ```
7. **Deploy the app code** to the App Service (zip deploy or your CI of
   choice), or run `npm start` locally against the real resources first to
   confirm everything connects.
8. **Publish content** through Azure Blob instead of the Cloudflare default:
   ```
   node packages/pipeline/publish.mjs --brand <your-id> \
     --source <path-to-your-content> --storage azure-blob
   ```
   See [`authoring-stories.md`](authoring-stories.md) for the content format.

## Nothing about your brand changes

Switching platforms never touches `brands/<id>/` — the same theme,
presentation, and content publish identically whether the site runs on
Cloudflare or Azure. Only the infrastructure underneath differs.
