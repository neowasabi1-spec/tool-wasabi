import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import {
  takeCode,
  getRefresh,
  saveRefresh,
  deleteRefresh,
  type RefreshData,
} from '@/lib/mcp/oauth/store';
import { signAccessToken } from '@/lib/mcp/oauth/jwt';
import { REFRESH_TOKEN_TTL } from '@/lib/mcp/oauth/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
  'cache-control': 'no-store',
};

function err(code: string, description: string, status = 400) {
  return NextResponse.json(
    { error: code, error_description: description },
    { status, headers: CORS },
  );
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = (await req.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j)) out[k] = String(v ?? '');
    return out;
  }
  // Default: application/x-www-form-urlencoded (OAuth standard)
  const text = await req.text();
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function newRefreshToken(): string {
  return `rt_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
}

function issue(userId: string, clientId: string, scope: string) {
  const { token: accessToken, expiresIn } = signAccessToken({ userId, clientId, scope });
  return { accessToken, expiresIn };
}

export async function POST(req: NextRequest) {
  const body = await parseBody(req);
  const grantType = body.grant_type;

  if (grantType === 'authorization_code') {
    const { code, redirect_uri, client_id, code_verifier } = body;
    if (!code || !client_id || !code_verifier) {
      return err('invalid_request', 'Missing code, client_id or code_verifier.');
    }
    const data = await takeCode(code);
    if (!data) return err('invalid_grant', 'Authorization code invalid or expired.');
    if (data.clientId !== client_id) return err('invalid_grant', 'client_id mismatch.');
    if (redirect_uri && data.redirectUri !== redirect_uri) {
      return err('invalid_grant', 'redirect_uri mismatch.');
    }
    // PKCE S256 verification.
    const challenge = b64url(createHash('sha256').update(code_verifier).digest());
    if (challenge !== data.codeChallenge) {
      return err('invalid_grant', 'PKCE verification failed.');
    }

    const { accessToken, expiresIn } = issue(data.userId, data.clientId, data.scope);
    const refreshToken = newRefreshToken();
    const refresh: RefreshData = {
      clientId: data.clientId,
      userId: data.userId,
      scope: data.scope,
      exp: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL,
    };
    await saveRefresh(refreshToken, refresh);

    return NextResponse.json(
      {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: refreshToken,
        scope: data.scope,
      },
      { headers: CORS },
    );
  }

  if (grantType === 'refresh_token') {
    const { refresh_token, client_id } = body;
    if (!refresh_token) return err('invalid_request', 'Missing refresh_token.');
    const data = await getRefresh(refresh_token);
    if (!data) return err('invalid_grant', 'Refresh token invalid or expired.');
    if (client_id && data.clientId !== client_id) {
      return err('invalid_grant', 'client_id mismatch.');
    }

    // Rotate the refresh token.
    await deleteRefresh(refresh_token);
    const { accessToken, expiresIn } = issue(data.userId, data.clientId, data.scope);
    const newRt = newRefreshToken();
    await saveRefresh(newRt, {
      clientId: data.clientId,
      userId: data.userId,
      scope: data.scope,
      exp: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL,
    });

    return NextResponse.json(
      {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: newRt,
        scope: data.scope,
      },
      { headers: CORS },
    );
  }

  return err('unsupported_grant_type', `Unsupported grant_type "${grantType}".`);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
