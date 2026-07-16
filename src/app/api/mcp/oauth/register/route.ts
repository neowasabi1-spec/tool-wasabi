import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { saveClient, type OAuthClient } from '@/lib/mcp/oauth/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

// RFC 7591 — OAuth 2.0 Dynamic Client Registration.
// Claude registers itself here and receives a public client_id (PKCE, no
// client secret).
export async function POST(req: NextRequest) {
  let body: {
    redirect_uris?: unknown;
    client_name?: unknown;
    grant_types?: unknown;
    response_types?: unknown;
    token_endpoint_auth_method?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: 'Body must be JSON' },
      { status: 400, headers: CORS },
    );
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];

  if (redirectUris.length === 0) {
    return NextResponse.json(
      {
        error: 'invalid_redirect_uri',
        error_description: 'At least one redirect_uris entry is required',
      },
      { status: 400, headers: CORS },
    );
  }

  const clientId = `mcp_${randomUUID().replace(/-/g, '')}`;
  const client: OAuthClient = {
    clientId,
    redirectUris,
    clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
    tokenEndpointAuthMethod: 'none',
    createdAt: Date.now(),
  };
  await saveClient(client);

  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: client.clientName,
    },
    { status: 201, headers: CORS },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
