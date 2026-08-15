// StoryLark on Azure — minimal, real infrastructure for one branded site.
// One deploy of this template = one brand: an App Service (the worker +
// static site), a PostgreSQL Flexible Server (the database driver in
// packages/worker/src/db/postgres.ts), and a Storage Account with a Blob
// container (the pipeline's azure-blob storage driver).
//
// Deploy with the installer (install.mjs), which fills these parameters
// from your .env file and runs `az deployment group create`.

@description('Short, unique brand id — used to derive every resource name (e.g. "gunner-the-lab").')
@minLength(3)
@maxLength(24)
param brandId string

@description('Azure region for every resource.')
param location string = resourceGroup().location

@description('PostgreSQL administrator username.')
param dbAdminUser string = 'storylark'

@description('PostgreSQL administrator password. Pass via --parameters, never commit a real value.')
@secure()
param dbAdminPassword string

@description('App Service plan SKU. B1 is the smallest that supports Always On, needed so the Node process (and its background push/email sends) stays warm.')
param appServiceSku string = 'B1'

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
}

resource contentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: '${brandId}-content'
  properties: {
    publicAccess: 'Blob'
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: postgresServerName
  location: location
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

resource postgresDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: postgres
  name: 'storylark'
}

// Allows Azure services (this App Service) to reach the database. Tighten
// with a VNet integration + private endpoint for production hardening —
// left open here to keep the out-of-the-box path simple, matching the
// Cloudflare recipe's own free-tier-first stance.
resource postgresFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
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
      alwaysOn: true
      appCommandLine: 'npm start --prefix platforms/azure'
      appSettings: [
        { name: 'BRAND', value: brandId }
        { name: 'DATABASE_URL', value: 'postgresql://${dbAdminUser}:${dbAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/storylark?sslmode=require' }
        { name: 'AZURE_STORAGE_CONNECTION_STRING', value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=core.windows.net' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
      ]
    }
  }
}

output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output storageAccountName string = storage.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
