import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { syncOwnAdsForProject, listAdAccounts, resolveAccessToken } from '@/lib/ads-intel/meta/sync';
import { envSpikeToken, metaAppId } from '@/lib/ads-intel/meta/graph';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const userId = await getCurrentUserId(req);
  let connected = false;
  let source: string | null = null;
  let accounts: { id: string; name: string }[] = [];
  try {
    const tok = await resolveAccessToken({ userId });
    connected = true;
    source = tok.source;
    accounts = await listAdAccounts(tok.token);
  } catch {
    connected = Boolean(envSpikeToken());
    source = connected ? 'env' : null;
  }

  const { count } = await supabaseAdmin
    .from('own_ads')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId);

  return NextResponse.json({
    connected,
    source,
    appConfigured: Boolean(metaAppId()),
    oauthStartPath: `/api/meta/oauth/start?projectId=${projectId}`,
    ownAdsCount: count || 0,
    accounts,
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const userId = await getCurrentUserId(req);
  const body = await req.json().catch(() => ({}));

  try {
    const result = await syncOwnAdsForProject({
      projectId,
      userId,
      adAccountId: body.adAccountId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
