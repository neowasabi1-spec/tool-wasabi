import { NextResponse } from 'next/server';
import { oauthConfig } from '@/lib/mcp/oauth/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
};

// RFC 9728 — OAuth 2.0 Protected Resource Metadata.
// Reachable at /.well-known/oauth-protected-resource via next.config rewrite.
export async function GET() {
  const cfg = oauthConfig();
  return NextResponse.json(
    {
      resource: cfg.resource,
      authorization_servers: [cfg.issuer],
      scopes_supported: cfg.scopesSupported,
      bearer_methods_supported: ['header'],
      resource_name: 'Tool Wasabi MCP',
    },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
