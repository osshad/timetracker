// Shared Cosmos DB client — singleton reused across function invocations
const { CosmosClient } = require('@azure/cosmos');
const { DefaultAzureCredential } = require('@azure/identity');
const { validateToken } = require('./auth');

let client = null;
let database = null;

function getCosmosClient() {
  if (!client) {
    const endpoint = process.env.COSMOS_ENDPOINT;
    if (!endpoint) {
      throw new Error('COSMOS_ENDPOINT not configured');
    }
    const credential = new DefaultAzureCredential();
    client = new CosmosClient({ endpoint, aadCredentials: credential });
    database = client.database('timetracker');
  }
  return database;
}

/**
 * Extract and validate the user from the request.
 * Checks Bearer token first (MSAL ID token), falls back to SWA header.
 * Returns userId (oid claim) or null if not authenticated.
 */
async function getUserId(req) {
  // Try Bearer token (MSAL ID token validation)
  const claims = validateToken(req);
  if (claims && claims.oid) {
    return claims.oid;
  }

  // Fallback: SWA injects the client principal header
  const header = req.headers['x-ms-client-principal'];
  if (header) {
    const principal = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return principal.userId;
  }

  return null;
}

module.exports = { getCosmosClient, getUserId };
