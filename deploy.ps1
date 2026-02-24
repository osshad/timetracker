# TimeTracker — Deploy to Azure (SWA + Cosmos DB)
# Run from the project root: .\deploy.ps1

$ErrorActionPreference = "Stop"

$RESOURCE_GROUP = "rg-timetracker"
$LOCATION = "centralus"
$COSMOS_ACCOUNT = "cosmos-timetracker-$(Get-Random -Minimum 1000 -Maximum 9999)"
$SWA_NAME = "swa-timetracker-$(Get-Random -Minimum 1000 -Maximum 9999)"
$AAD_CLIENT_ID = "aae64d99-3c77-4c08-8d81-70b28366a42e"

Write-Host "`n=== TimeTracker Azure Deployment ===" -ForegroundColor Cyan

# 1. Ensure resource group
Write-Host "`n[1/7] Creating resource group: $RESOURCE_GROUP" -ForegroundColor Yellow
az group create --name $RESOURCE_GROUP --location $LOCATION -o none

# 2. Create Cosmos DB serverless account
Write-Host "[2/7] Creating Cosmos DB account: $COSMOS_ACCOUNT (serverless)" -ForegroundColor Yellow
az cosmosdb create `
  --name $COSMOS_ACCOUNT `
  --resource-group $RESOURCE_GROUP `
  --kind GlobalDocumentDB `
  --capabilities EnableServerless `
  --default-consistency-level Session `
  -o none

# 3. Create database and containers
Write-Host "[3/7] Creating database and containers" -ForegroundColor Yellow
az cosmosdb sql database create `
  --account-name $COSMOS_ACCOUNT `
  --resource-group $RESOURCE_GROUP `
  --name timetracker `
  -o none

az cosmosdb sql container create `
  --account-name $COSMOS_ACCOUNT `
  --resource-group $RESOURCE_GROUP `
  --database-name timetracker `
  --name entries `
  --partition-key-path "/userId" `
  -o none

az cosmosdb sql container create `
  --account-name $COSMOS_ACCOUNT `
  --resource-group $RESOURCE_GROUP `
  --database-name timetracker `
  --name projects `
  --partition-key-path "/userId" `
  -o none

# 4. Get Cosmos DB connection string
Write-Host "[4/7] Getting Cosmos DB connection string" -ForegroundColor Yellow
$COSMOS_CONN = az cosmosdb keys list `
  --name $COSMOS_ACCOUNT `
  --resource-group $RESOURCE_GROUP `
  --type connection-strings `
  --query "connectionStrings[0].connectionString" `
  --output tsv

# 5. Create Static Web App
Write-Host "[5/7] Creating Azure Static Web App: $SWA_NAME" -ForegroundColor Yellow
az staticwebapp create `
  --name $SWA_NAME `
  --resource-group $RESOURCE_GROUP `
  --location $LOCATION `
  --sku Free `
  -o none

# 6. Configure app settings
Write-Host "[6/7] Configuring app settings" -ForegroundColor Yellow
az staticwebapp appsettings set `
  --name $SWA_NAME `
  --resource-group $RESOURCE_GROUP `
  --setting-names "COSMOS_CONNECTION_STRING=$COSMOS_CONN" "AAD_CLIENT_ID=$AAD_CLIENT_ID" `
  -o none

# 7. Install npm deps in api folder, then deploy with SWA CLI
Write-Host "[7/7] Installing API dependencies and deploying" -ForegroundColor Yellow
Push-Location api
npm install --production
Pop-Location

$DEPLOYMENT_TOKEN = az staticwebapp secrets list `
  --name $SWA_NAME `
  --resource-group $RESOURCE_GROUP `
  --query "properties.apiKey" `
  --output tsv

npx --yes @azure/static-web-apps-cli deploy `
  --app-location "." `
  --api-location "api" `
  --output-location "." `
  --deployment-token $DEPLOYMENT_TOKEN `
  --env default

# Done
$SWA_URL = az staticwebapp show `
  --name $SWA_NAME `
  --resource-group $RESOURCE_GROUP `
  --query "defaultHostname" `
  --output tsv

Write-Host "`n=== Deployment Complete ===" -ForegroundColor Green
Write-Host "Website URL: https://$SWA_URL" -ForegroundColor Cyan
Write-Host "Cosmos DB: $COSMOS_ACCOUNT" -ForegroundColor Gray
Write-Host "Static Web App: $SWA_NAME" -ForegroundColor Gray
Write-Host "`nIMPORTANT: Add these redirect URIs to your Azure AD App Registration:" -ForegroundColor Yellow
Write-Host "  https://$SWA_URL" -ForegroundColor White
Write-Host "  https://$SWA_URL/.auth/login/aad/callback" -ForegroundColor White
Write-Host "  (Portal > App registrations > $AAD_CLIENT_ID > Authentication > Add redirect URI)`n" -ForegroundColor Gray
