import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const PROJECT_FILES_BUCKET = 'project-files';

type SwipePage = {
  funnelPageId: string;
  sourcePageId: string;
  sourceUrl: string;
  name: string;
  type: string;
  htmlUrl?: string;
};

/**
 * POST /api/chimera/swipe
 * Start the Internal restyle worker (palette + regenerate photos) on
 * existing Clone/Swipe rows. Same worker Chimera Protocol uses.
 *
 * GET  /api/chimera/swipe?ids=uuid,uuid
 * Poll swipe_status / swipe_result for those rows.
 */
export async function GET(req: NextRequest) {
  const ids = String(req.nextUrl.searchParams.get('ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);
  if (!ids.length) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('funnel_pages')
    .select('id, swipe_status, swipe_result, project_id, product_id, owner_user_id, updated_at')
    .in('id', ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ctx = await getUserAccessContext(req);
  const rows = data || [];
  const STALE_QUEUED_MS = 2 * 60_000;
  const STALE_ANY_MS = 12 * 60_000;
  for (const row of rows) {
    if (row.swipe_status !== 'in_progress') continue;
    const age = Date.now() - new Date(String(row.updated_at || 0)).getTime();
    const queued = /restyle queued/i.test(String(row.swipe_result || ''));
    const stale = (queued && age > STALE_QUEUED_MS) || age > STALE_ANY_MS;
    if (!stale) continue;
    const msg = queued
      ? 'Restyle stalled — worker never started. Click Restyle again.'
      : 'Restyle stalled — worker stopped mid-run. Click Restyle again.';
    await supabaseAdmin
      .from('funnel_pages')
      .update({ swipe_status: 'failed', swipe_result: msg })
      .eq('id', row.id);
    row.swipe_status = 'failed';
    row.swipe_result = msg;
  }
  if (ctx.userId && !ctx.isMaster) {
    for (const row of rows) {
      const projectId = String(row.project_id || row.product_id || '');
      if (projectId) {
        const { allowed } = await canAccessProject(req, projectId);
        if (!allowed && row.owner_user_id !== ctx.userId) {
          return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }
      } else if (row.owner_user_id && row.owner_user_id !== ctx.userId) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    }
  }

  return NextResponse.json({
    pages: rows.map((r) => ({
      id: r.id,
      swipeStatus: r.swipe_status || 'pending',
      swipeResult: r.swipe_result || '',
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.unstick === true) {
    return unstickPages(req, body);
  }
  const pageIds = (Array.isArray(body.pageIds) ? body.pageIds : [])
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .slice(0, 20);
  const imageMode = body.imageMode === 'affiliate' ? 'affiliate' : 'internal';
  const skipTexts = body.skipTexts === true;
  if (!pageIds.length) {
    return NextResponse.json({ error: 'pageIds required' }, { status: 400 });
  }

  const { data: rows, error } = await supabaseAdmin
    .from('funnel_pages')
    .select('id, name, page_type, url_to_swipe, project_id, product_id, cloned_data, owner_user_id')
    .in('id', pageIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows?.length) return NextResponse.json({ error: 'No matching pages' }, { status: 404 });

  const requestedProject = String(body.projectId || '').trim();
  const projectId =
    requestedProject
    || String(rows[0].project_id || rows[0].product_id || '');
  if (!projectId) {
    return NextResponse.json(
      { error: 'Link a project on the row before Internal restyle.' },
      { status: 400 },
    );
  }

  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const pages: SwipePage[] = rows.map((r) => {
    const cloned = (r.cloned_data && typeof r.cloned_data === 'object'
      ? r.cloned_data
      : {}) as Record<string, unknown>;
    const htmlUrl = typeof cloned.htmlUrl === 'string' ? cloned.htmlUrl : '';
    return {
      funnelPageId: r.id as string,
      sourcePageId: r.id as string,
      sourceUrl: String(r.url_to_swipe || ''),
      name: String(r.name || 'Step'),
      type: String(r.page_type || 'landing'),
      htmlUrl,
    };
  });

  const mainImageUrl = await loadMainProductImageUrl(projectId);
  const queued = skipTexts
    ? 'Palette + photos/gifs/videos on Clone/Swipe copy…'
    : 'Clone/Swipe rewrite queued, then colors + photos…';
  await supabaseAdmin
    .from('funnel_pages')
    .update({ swipe_status: 'in_progress', swipe_result: queued })
    .in('id', pages.map((p) => p.funnelPageId));

  const origin = (
    process.env.URL
    || process.env.DEPLOY_PRIME_URL
    || req.nextUrl.origin
  ).replace(/\/$/, '');
  const secret = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';

  try {
    await fetch(`${origin}/.netlify/functions/pipeline-swipe-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        secret,
        market: '',
        mainImageUrl,
        imageMode,
        skipTexts,
        pages,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) {
    // Background functions ACK with 202; a timeout here is usually fine.
    console.warn('[chimera swipe] trigger:', (e as Error).message);
  }

  return NextResponse.json({
    ok: true,
    projectId,
    imageMode,
    pageIds: pages.map((p) => p.funnelPageId),
    photo: Boolean(mainImageUrl),
  });
}

async function unstickPages(req: NextRequest, body: Record<string, unknown>) {
  const pageIds = (Array.isArray(body.pageIds) ? body.pageIds : [])
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .slice(0, 40);
  if (!pageIds.length) {
    return NextResponse.json({ error: 'pageIds required' }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin
    .from('funnel_pages')
    .select('id, swipe_status, swipe_result, project_id, product_id, owner_user_id')
    .in('id', pageIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const ctx = await getUserAccessContext(req);
  const msg = 'Restyle stalled — worker never started. Click Restyle again.';
  const out: Array<{ id: string; swipeStatus: string; swipeResult: string }> = [];
  for (const row of data || []) {
    if (ctx.userId && !ctx.isMaster) {
      const projectId = String(row.project_id || row.product_id || '');
      if (projectId) {
        const { allowed } = await canAccessProject(req, projectId);
        if (!allowed && row.owner_user_id !== ctx.userId) continue;
      } else if (row.owner_user_id && row.owner_user_id !== ctx.userId) {
        continue;
      }
    }
    if (row.swipe_status !== 'in_progress') {
      out.push({ id: row.id, swipeStatus: row.swipe_status || 'pending', swipeResult: row.swipe_result || '' });
      continue;
    }
    await supabaseAdmin
      .from('funnel_pages')
      .update({ swipe_status: 'failed', swipe_result: msg })
      .eq('id', row.id);
    out.push({ id: row.id, swipeStatus: 'failed', swipeResult: msg });
  }
  return NextResponse.json({ ok: true, pages: out });
}

async function loadMainProductImageUrl(projectId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from('project_files')
      .select('file_path, original_name, created_at')
      .eq('project_id', projectId)
      .eq('file_type', 'product_image')
      .order('created_at', { ascending: false })
      .limit(20);
    const rows = (data || []) as Array<{ file_path: string; original_name?: string | null }>;
    if (!rows.length) return null;
    const main = rows.find((r) => !/upsell/i.test(r.original_name || '')) || rows[0];
    const { data: pub } = supabaseAdmin.storage.from(PROJECT_FILES_BUCKET).getPublicUrl(main.file_path);
    return pub?.publicUrl || null;
  } catch {
    return null;
  }
}
