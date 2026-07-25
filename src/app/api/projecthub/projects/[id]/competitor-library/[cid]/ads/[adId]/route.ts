import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/projecthub/projects/:id/competitor-library/:cid/ads/:adId
 * Manually flag/unflag a creative as a winner. Body: { is_winner: boolean }.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; cid: string; adId: string } },
) {
  const { id, cid, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const adIdNum = Number(adId);
  if (!Number.isFinite(adIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { is_winner?: unknown };
  if (typeof body.is_winner !== 'boolean') {
    return NextResponse.json({ error: 'is_winner (boolean) is required' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .update({ is_winner: body.is_winner })
    .eq('id', adIdNum)
    .eq('project_id', id)
    .eq('brand_id', Number(cid))
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * DELETE /api/projecthub/projects/:id/competitor-library/:cid/ads/:adId
 * Removes a single competitor ad and its stored media file (if local).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; cid: string; adId: string } },
) {
  const { id, cid, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const adIdNum = Number(adId);
  if (!Number.isFinite(adIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('file_path')
    .eq('id', adIdNum)
    .eq('project_id', id)
    .maybeSingle();

  const filePath = (ad as { file_path?: string } | null)?.file_path || '';
  if (filePath && !/^https?:\/\//i.test(filePath)) {
    await supabaseAdmin.storage.from('project-files').remove([filePath]).catch(() => {});
  }

  const { error } = await supabaseAdmin
    .from('competitor_ads')
    .delete()
    .eq('id', adIdNum)
    .eq('project_id', id)
    .eq('brand_id', Number(cid));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
