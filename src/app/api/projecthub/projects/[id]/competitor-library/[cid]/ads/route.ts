import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { insertCompetitorAd, mediaTypeForContentType } from '@/lib/competitor-ads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Competitor Library — ads for a brand.
 *
 *   GET  → list competitor_ads for the brand
 *   POST → multipart upload (file + name/headline/hook/body_text)
 */

export async function GET(
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

  const { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('*')
    .eq('project_id', id)
    .eq('brand_id', brandId)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

export async function POST(
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

  const fd = await req.formData().catch(() => null);
  if (!fd) return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });

  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  const contentType =
    file.type || (mediaTypeForContentType(file.type) === 'video' ? 'video/mp4' : 'image/jpeg');
  const buffer = Buffer.from(await file.arrayBuffer());

  const result = await insertCompetitorAd({
    projectId: id,
    brandId,
    buffer,
    contentType,
    originalName: file.name,
    meta: {
      name: String(fd.get('name') || file.name.replace(/\.[^.]+$/, '')),
      headline: String(fd.get('headline') || ''),
      hook: String(fd.get('hook') || ''),
      body_text: String(fd.get('body_text') || ''),
    },
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json(result.ad);
}
