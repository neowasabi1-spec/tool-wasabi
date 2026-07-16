import { NextResponse } from 'next/server';
import { oauthConfig } from '@/lib/mcp/oauth/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
};

// RFC 8414 — OAuth 2.0 Authorization Server Metadata.
// Reachable at /.well-known/oauth-authorization-server via next.config rewrite.
export async function GET() {
  const cfg = oauthConfig();
  return NextResponse.json(
    {
      issuer: cfg.issuer,
      authorization_endpoint: cfg.authorizationEndpoint,
      token_endpoint: cfg.tokenEndpoint,
      registration_endpoint: cfg.registrationEndpoint,
      scopes_supported: cfg.scopesSupported,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
