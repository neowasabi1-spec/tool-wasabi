import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { backgroundOrigin } from '@/lib/segment-enqueue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Legacy shots = saved before tagging/band measurement existed. When listed,
// we fire the reanalyze background function once (cooldown per project) so
// they gain tags + a measured subtitle band and become usable in builds.
const BAND_RE = /[01]?\.\d+-[01]?\.\d+/;
const reanalyzeFiredAt = new Map<string, number>();
const REANALYZE_COOLDOWN_MS = 10 * 60 * 1000;

function maybeTriggerReanalysis(projectId: string, rows: Array<Record<string, unknown>>, origin: string) {
  const legacy = rows.some((r) => {
    if (!r.thumb_path) return false;
    const tags = r.tags as string[] | null | undefined;
    if (!Array.isArray(tags) || tags.length === 0) return true;
    return r.has_text === true && !BAND_RE.test(String(r.text_region || ''));
  });
  if (!legacy) return;
  const last = reanalyzeFiredAt.get(projectId) || 0;
  if (Date.now() - last < REANALYZE_COOLDOWN_MS) return;
  reanalyzeFiredAt.set(projectId, Date.now());
  fetch(`${backgroundOrigin(origin)}/.netlify/functions/reanalyze-shots-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  }).catch(() => { /* fire and forget */ });
}

/**
 * GET /api/projecthub/projects/:id/shots
 * List extracted competitor SHOTS for the project. Optional filters:
 *   ?brandId=  ?adId=  ?cleanOnly=1  (has_text is false/null)
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const sp = req.nextUrl.searchParams;
  const brandId = sp.get('brandId');
  const adId = sp.get('adId');
  const cleanOnly = sp.get('cleanOnly') === '1';

  let q = supabaseAdmin
    .from('competitor_shots')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: false });

  if (brandId && Number.isFinite(Number(brandId))) q = q.eq('brand_id', Number(brandId));
  if (adId && Number.isFinite(Number(adId))) q = q.eq('ad_id', Number(adId));

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let rows = data || [];
  if (cleanOnly) rows = rows.filter((r) => (r as { has_text?: boolean }).has_text !== true);

  maybeTriggerReanalysis(id, rows as Array<Record<string, unknown>>, new URL(req.url).origin);

  return NextResponse.json(rows);
}
