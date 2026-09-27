import { NextRequest, NextResponse } from 'next/server';
import { metaAppId, metaAppSecret, graphGet } from '@/lib/ads-intel/meta/graph';
import { upsertUserToken } from '@/lib/ads-intel/meta/sync';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state') || '';
  let projectId = '';
  let userId: string | null = null;
  try {
    const state = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8'));
    projectId = state.projectId || '';
    userId = state.userId || null;
  } catch {
    /* ignore */
  }

  if (!code) {
    return NextResponse.redirect(`${url.origin}/projects/${projectId}?section=creative&meta=error`);
  }
  if (!userId) {
    return NextResponse.redirect(`${url.origin}/projects/${projectId}?section=creative&meta=need_login`);
  }

  const redirectUri = `${url.origin}/api/meta/oauth/callback`;
  const version = (process.env.META_GRAPH_VERSION || 'v23.0').trim();
  const tokenUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  tokenUrl.searchParams.set('client_id', metaAppId());
  tokenUrl.searchParams.set('client_secret', metaAppSecret());
  tokenUrl.searchParams.set('redirect_uri', redirectUri);
  tokenUrl.searchParams.set('code', code);

  const tokenRes = await fetch(tokenUrl.toString());
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) {
    return NextResponse.redirect(`${url.origin}/projects/${projectId}?section=creative&meta=token_fail`);
  }

  let fbUserId = '';
  try {
    const me = await graphGet('me', { fields: 'id' }, tokenJson.access_token);
    fbUserId = String(me.id || '');
  } catch {
    /* optional */
  }

  await upsertUserToken(userId, tokenJson.access_token, fbUserId, ['ads_read', 'business_management']);

  return NextResponse.redirect(`${url.origin}/projects/${projectId}?section=creative&meta=connected`);
}
