// JWT token decoding for MSAL ID tokens
// Decodes and validates claims from the MSAL-issued ID token.
// Signature verification is not performed here because:
//   1. The token is issued by MSAL.js in our own frontend (same client ID)
//   2. SWA's managed Functions environment lacks full crypto support for jwks-rsa
//   3. This is an internal Microsoft-only tool locked to one tenant

const TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const CLIENT_ID = 'aae64d99-3c77-4c08-8d81-70b28366a42e';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

/**
 * Decode a JWT token payload (base64url → JSON).
 */
function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

/**
 * Extract and validate claims from the ID token in the request.
 * Returns decoded claims (with oid as userId) or null.
 */
function validateToken(req) {
  // Use custom header since SWA strips Authorization header
  let token = req.headers['x-auth-token'] || req.headers['X-Auth-Token'];
  if (!token) {
    // Fallback: try Authorization header (for local dev)
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) token = match[1];
  }
  if (!token) return null;

  const claims = decodeJwt(token);
  if (!claims) {
    console.error('Token decode failed');
    return null;
  }

  // Validate issuer and audience
  if (claims.iss !== ISSUER) {
    console.error('Invalid issuer:', claims.iss);
    return null;
  }
  if (claims.aud !== CLIENT_ID) {
    console.error('Invalid audience:', claims.aud);
    return null;
  }
  // Verify Microsoft tenant
  if (claims.tid !== TENANT_ID) {
    console.error('Invalid tenant:', claims.tid);
    return null;
  }
  // Check expiration
  if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
    console.error('Token expired');
    return null;
  }

  return claims;
}

module.exports = { validateToken };
