import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DELETE /api/projecthub/projects/:id/competitor-library/:cid
 * Removes a competitor brand plus its ads (FK cascade) and the ads' stored
 * media files. Stored file paths that are actually remote URLs are skipped.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; cid: string } },
) {
  const { id, cid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const brandId = Number(cid);
  if (!Number.isFinite(brandId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  // Best-effort: purge stored media for this brand's ads.
  const { data: ads } = await supabaseAdmin
    .from('competitor_ads')
    .select('file_path')
    .eq('project_id', id)
    .eq('brand_id', brandId);
  const keys = ((ads || []) as { file_path: string }[])
    .map((a) => a.file_path)
    .filter((p) => p && !/^https?:\/\//i.test(p));
  if (keys.length > 0) {
    await supabaseAdmin.storage.from('project-files').remove(keys).catch(() => {});
  }

  const { error } = await supabaseAdmin
    .from('competitor_brands')
    .delete()
    .eq('id', brandId)
    .eq('project_id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}

/**
 * PATCH /api/projecthub/projects/:id/competitor-library/:cid
 * Update a brand's scrape settings (ads_library_url, frequency, is_active,
 * scrape_count, name).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; cid: string } },
) {
  const { id, cid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const brandId = Number(cid);
  if (!Number.isFinite(brandId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof body.ads_library_url === 'string') patch.ads_library_url = body.ads_library_url.trim();
  if (typeof body.frequency === 'string') patch.frequency = body.frequency.trim();
  if (typeof body.is_active === 'string') patch.is_active = body.is_active;
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (Number.isFinite(Number(body.scrape_count))) patch.scrape_count = Number(body.scrape_count);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('competitor_brands')
    .update(patch)
    .eq('id', brandId)
    .eq('project_id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}
