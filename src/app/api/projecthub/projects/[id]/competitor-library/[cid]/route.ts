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
