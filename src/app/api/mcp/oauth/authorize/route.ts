import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getClient, saveCode, type AuthCodeData } from '@/lib/mcp/oauth/store';
import { AUTH_CODE_TTL, OAUTH_SCOPES } from '@/lib/mcp/oauth/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

/**
 * Mints an authorization code AFTER the consent page has confirmed the user
 * is logged into this tool. Called by /mcp/authorize (client page) with the
 * user's Supabase access token; we verify it server-side and bind the code
 * to that user id. PKCE (code_challenge) is stored for the token exchange.
 */
export async function POST(req: NextRequest) {
  let body: {
    supabaseAccessToken?: string;
    client_id?: string;
    redirect_uri?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    scope?: string;
    state?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: CORS });
  }

  const {
    supabaseAccessToken,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    scope,
    state,
  } = body;

  if (!supabaseAccessToken) {
    return NextResponse.json(
      { error: 'login_required', error_description: 'Not authenticated on this tool.' },
      { status: 401, headers: CORS },
    );
  }
  if (!client_id || !redirect_uri || !code_challenge) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Missing client_id, redirect_uri or code_challenge.' },
      { status: 400, headers: CORS },
    );
  }
  if (code_challenge_method && code_challenge_method !== 'S256') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Only S256 PKCE is supported.' },
      { status: 400, headers: CORS },
    );
  }

  // Verify the tool user (Supabase) — this is WHO the token will belong to.
  let userId: string;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(supabaseAccessToken);
    if (error || !data?.user) {
      return NextResponse.json(
        { error: 'login_required', error_description: 'Invalid session.' },
        { status: 401, headers: CORS },
      );
    }
    userId = data.user.id;
  } catch {
    return NextResponse.json(
      { error: 'server_error', error_description: 'Could not verify session.' },
      { status: 500, headers: CORS },
    );
  }

  const client = await getClient(client_id);
  if (!client) {
    return NextResponse.json(
      { error: 'invalid_client', error_description: 'Unknown client_id.' },
      { status: 400, headers: CORS },
    );
  }
  if (!client.redirectUris.includes(redirect_uri)) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri not registered for this client.' },
      { status: 400, headers: CORS },
    );
  }

  const grantedScope = scope && scope.trim() ? scope.trim() : OAUTH_SCOPES.join(' ');
  const code = `code_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
  const data: AuthCodeData = {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: 'S256',
    userId,
    scope: grantedScope,
    exp: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL,
  };
  await saveCode(code, data);

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  return NextResponse.json({ redirect: url.toString() }, { headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
