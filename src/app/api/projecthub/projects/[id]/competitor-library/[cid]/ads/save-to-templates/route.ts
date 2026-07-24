import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/projecthub/projects/:id/competitor-library/:cid/ads/save-to-templates
 * Copies the selected competitor ads into creative_templates so they show up
 * in the project's saved templates. Body: { ad_ids: number[] }.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; cid: string } },
) {
  const { id, cid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const adIds = Array.isArray(body.ad_ids)
    ? body.ad_ids.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n))
    : [];
  if (adIds.length === 0) return NextResponse.json([], { status: 200 });

  const { data: ads, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, name, headline, hook, file_path, media_type')
    .eq('project_id', id)
    .eq('brand_id', Number(cid))
    .in('id', adIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: brand } = await supabaseAdmin
    .from('competitor_brands')
    .select('name')
    .eq('id', Number(cid))
    .maybeSingle();
  const sourceBrand = (brand as { name?: string } | null)?.name || '';

  type AdSel = {
    id: number;
    name: string;
    headline: string;
    hook: string;
    file_path: string;
    media_type: string;
  };
  const rows = ((ads || []) as AdSel[]).map((a) => ({
    project_id: id,
    name: a.name || a.headline || 'Creative',
    source_brand: sourceBrand,
    category: '',
    file_path: a.file_path,
    media_type: a.media_type,
    tags: [a.hook].filter(Boolean).join(','),
  }));

  if (rows.length === 0) return NextResponse.json([], { status: 200 });

  const { data: created, error: insErr } = await supabaseAdmin
    .from('creative_templates')
    .insert(rows)
    .select();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  return NextResponse.json(created || []);
}
