import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { ensureBrand } from '@/lib/competitor-ads';
import { autoSplitIfVideo } from '@/lib/segment-enqueue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OWN_BRAND = 'My Footage';

async function getOwnBrandId(projectId: string): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from('competitor_brands')
    .select('id')
    .eq('project_id', projectId)
    .eq('name', OWN_BRAND)
    .maybeSingle();
  return (data as { id?: number } | null)?.id ?? null;
}

/**
 * GET /api/projecthub/projects/:id/my-footage
 * List the user's own uploaded videos (brand "My Footage"). Returns
 * { brandId, videos: [...] } so the UI can call the shared segment endpoint.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const brandId = await getOwnBrandId(id);
  if (!brandId) return NextResponse.json({ brandId: null, videos: [] });

  const { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, brand_id, file_path, media_type, name, created_at')
    .eq('project_id', id)
    .eq('brand_id', brandId)
    .eq('media_type', 'video')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ brandId, videos: data || [] });
}

/**
 * POST /api/projecthub/projects/:id/my-footage
 * Register a video already uploaded to storage (via the signed URL) as a
 * creative under the "My Footage" brand. Body: { file_path, name }
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const filePath = String(body.file_path || '').trim();
  if (!filePath) return NextResponse.json({ error: 'file_path required' }, { status: 400 });

  const brandId = await ensureBrand(id, OWN_BRAND, '');
  if (!brandId) return NextResponse.json({ error: 'Could not prepare folder' }, { status: 500 });

  const name = String(body.name || 'My clip').slice(0, 300);
  const { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .insert({
      project_id: id,
      brand_id: brandId,
      file_path: filePath,
      media_type: 'video',
      name,
    })
    .select('id, brand_id, file_path, media_type, name, created_at')
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Insert failed' }, { status: 500 });
  }

  // Auto-split the uploaded video into shots immediately.
  await autoSplitIfVideo({
    projectId: id,
    brandId,
    adId: Number((data as { id: number }).id),
    mediaType: 'video',
    filePath,
    origin: new URL(req.url).origin,
  });

  return NextResponse.json({ video: data, brandId, autoSplit: true });
}
