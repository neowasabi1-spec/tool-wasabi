import { getBaseUrl } from '@/lib/mcp/base-url';

/**
 * Central config for the MCP OAuth 2.1 authorization server.
 *
 * This server is the "connect your own Claude" login layer: each user
 * authenticates with THEIR existing account on this tool (Supabase Auth),
 * and Claude receives a per-user access token. There is no shared secret
 * handed to users.
 */

export const OAUTH_SCOPES = ['mcp:use'] as const;

export function oauthConfig() {
  const base = getBaseUrl();
  return {
    issuer: base,
    baseUrl: base,
    /** The protected resource (our MCP endpoint). */
    resource: `${base}/api/mcp`,
    authorizationEndpoint: `${base}/mcp/authorize`,
    tokenEndpoint: `${base}/api/mcp/oauth/token`,
    registrationEndpoint: `${base}/api/mcp/oauth/register`,
    protectedResourceMetadataUrl: `${base}/.well-known/oauth-protected-resource`,
    scopesSupported: [...OAUTH_SCOPES],
  };
}

/** TTLs (seconds). */
export const ACCESS_TOKEN_TTL = 60 * 60; // 1h
export const AUTH_CODE_TTL = 60 * 5; // 5m
export const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30; // 30d

/**
 * HMAC secret used to sign access tokens. Prefer a dedicated secret; fall
 * back to the Supabase service-role key (already a high-entropy secret) so
 * the server still works if a dedicated one wasn't set — but a dedicated
 * `MCP_TOKEN_SIGNING_SECRET` is strongly recommended in production.
 */
export function signingSecret(): string {
  const s =
    process.env.MCP_TOKEN_SIGNING_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!s) {
    throw new Error(
      'MCP_TOKEN_SIGNING_SECRET (or SUPABASE_SERVICE_ROLE_KEY) must be set to sign MCP access tokens.',
    );
  }
  return s;
}
