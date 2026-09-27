import { NextRequest, NextResponse } from 'next/server';
import { metaAppId } from '@/lib/ads-intel/meta/graph';
import { getCurrentUserId } from '@/lib/auth/get-current-user';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const appId = metaAppId();
  if (!appId) {
    return NextResponse.json(
      { error: 'META_APP_ID not configured. For local spike use META_ACCESS_TOKEN instead.' },
      { status: 500 },
    );
  }

  const userId = await getCurrentUserId(req);
  const projectId = new URL(req.url).searchParams.get('projectId') || '';
  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/meta/oauth/callback`;
  const state = Buffer.from(JSON.stringify({ projectId, userId, t: Date.now() })).toString('base64url');

  const version = (process.env.META_GRAPH_VERSION || 'v23.0').trim();
  const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'ads_read,business_management');

  return NextResponse.redirect(url.toString());
}
