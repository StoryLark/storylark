// StoryLark on Azure — minimal, real infrastructure for one branded site.
// One deploy of this template = one brand: an App Service (the worker +
// static site), a PostgreSQL Flexible Server (the database driver in
// packages/worker/src/db/postgres.ts), and a Storage Account with a Blob
// container (the pipeline's azure-blob storage driver).
//
// Deploy with the installer (install.mjs), which fills these parameters
// from your .env file and runs `az deployment group create`.

@description('Short, unique brand id — used to derive every resource name (e.g. "my-story-app").')
@minLength(3)
@maxLength(24)
param brandId string

@description('Brand folder to run (brands/<brand>/) — defaults to brandId, override if your Azure resource prefix differs from your brand folder name.')
param brand string = brandId

@description('Azure region for every resource except PostgreSQL (see dbLocation).')
param location string = resourceGroup().location

@description('Azure region for the PostgreSQL Flexible Server. Separate from `location` because Flexible Server provisioning is restricted per-subscription to a subset of regions — pick one where Microsoft.DBforPostgreSQL/locations/<region>/capabilities returns no restriction reason.')
param dbLocation string = location

@description('PostgreSQL administrator username.')
param dbAdminUser string = 'storylark'

@description('PostgreSQL administrator password. Pass via --parameters, never commit a real value.')
@secure()
param dbAdminPassword string

@description('App Service plan SKU. B1 is the smallest that supports Always On, needed so the Node process (and its background push/email sends) stays warm.')
param appServiceSku string = 'B1'

@description('Human-readable app name shown in the UI (About screen, mail templates). Defaults to brand if not set.')
param appName string = brand

@description('The From: address for transactional email, e.g. "Your App <noreply@example.com>". Update once you have a real domain — the default is a placeholder.')
param mailFrom string = '${appName} <noreply@example.com>'

@description('Admin portal (/admin) access key — the x-admin-key header value it checks. Leave empty to keep the admin portal disabled (its routes 401 without one). Pass via --parameters, never commit a real value.')
@secure()
param adminKey string = ''

var storageAccountName = toLower(replace('${brandId}content', '-', ''))
var postgresServerName = '${brandId}-db'
var appServicePlanName = '${brandId}-plan'
var webAppName = '${brandId}-app'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take(storageAccountName, 24)
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: true // content is served publicly by design (contentOrigin)
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    // The app fetches manifest.json/chapters directly from this storage
    // account (contentOrigin) from the App Service's own origin — a
    // cross-origin browser fetch. Without this, the browser silently blocks
    // it (confirmed live: curl succeeds fine, but no Access-Control-Allow-
    // Origin header means a real browser fetch() fails with no server-side
    // error to point at). Content here is already public by design
    // (allowBlobPublicAccess/publicAccess: 'Blob' below), so '*' matches
    // that — this isn't opening up anything that wasn't already public.
    cors: {
      corsRules: [
        {
          allowedOrigins: ['*']
          allowedMethods: ['GET', 'HEAD', 'OPTIONS']
          allowedHeaders: ['*']
          exposedHeaders: ['*']
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}

resource contentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: '${brandId}-content'
  properties: {
    publicAccess: 'Blob'
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: postgresServerName
  location: dbLocation
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: dbAdminUser
    administratorLoginPassword: dbAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7 }
  }
}

resource postgresDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: postgres
  name: 'storylark'
}

// migrations-postgres/0001_init.sql uses `CREATE EXTENSION citext` (matching
// user emails case-insensitively). Flexible Server rejects CREATE EXTENSION
// for anything not on this allow-list — without it, migrate-postgres.mjs
// fails with "extension \"citext\" is not allow-listed for users".
resource postgresExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'citext'
    source: 'user-override'
  }
}

// Allows Azure services (this App Service) to reach the database. Tighten
// with a VNet integration + private endpoint for production hardening —
// left open here to keep the out-of-the-box path simple, matching the
// Cloudflare recipe's own free-tier-first stance.
resource postgresFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  sku: { name: appServiceSku }
  kind: 'linux'
  properties: { reserved: true }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      alwaysOn: appServiceSku != 'F1' // Free tier doesn't support Always On
      // The deployed site root IS platforms/azure's own contents (server.mjs,
      // package.json, app/dist) — see install.mjs's deploy step. platforms/azure
      // is deliberately NOT an npm workspace member: Oryx extracts a built
      // node_modules to an absolute /node_modules path and re-symlinks it back,
      // which breaks npm workspaces' relative symlinks (confirmed:
      // ERR_MODULE_NOT_FOUND for storylark-worker when it was a workspace member).
      // Standalone, `npm install` resolves storylark-worker from the real npm
      // registry, same as any customer's deployment would.
      appCommandLine: 'npm start'
      appSettings: [
        { name: 'BRAND', value: brand }
        { name: 'APP_NAME', value: appName }
        { name: 'APP_ORIGIN', value: 'https://${webAppName}.azurewebsites.net' }
        { name: 'CONTENT_ORIGIN', value: 'https://${storage.name}.blob.core.windows.net/${brandId}-content' }
        { name: 'MAIL_FROM', value: mailFrom }
        { name: 'DATABASE_URL', value: 'postgresql://${dbAdminUser}:${dbAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/storylark?sslmode=require' }
        { name: 'AZURE_STORAGE_CONNECTION_STRING', value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=core.windows.net' }
        { name: 'ADMIN_KEY', value: adminKey }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
      ]
    }
  }
}

output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output storageAccountName string = storage.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output appOrigin string = 'https://${webAppName}.azurewebsites.net'
output contentOrigin string = 'https://${storage.name}.blob.core.windows.net/${brandId}-content'
