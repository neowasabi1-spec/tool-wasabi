import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { insertCompetitorAd, mediaTypeForContentType } from '@/lib/competitor-ads';
import { loadSeenAt, tagNewAds } from '@/lib/competitor-seen';

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

  const AD_LIST_COLS =
    'id, project_id, brand_id, name, headline, hook, body_text, transcript, media_type, file_path, media_hash, is_winner, ad_active, ad_started_at, spend, impressions, clean_status, clean_full_path, clean_error, relevance_score, relevance_label, relevance_why, created_at';

  const [{ data, error }, seenAt] = await Promise.all([
    supabaseAdmin
      .from('competitor_ads')
      .select(AD_LIST_COLS)
      .eq('project_id', id)
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false })
      .limit(500),
    loadSeenAt(id),
  ]);

  if (error) {
    // Older DBs may lack optional columns — retry a leaner select.
    if (/42703|PGRST204|column/i.test(error.message || '')) {
      const lean = await supabaseAdmin
        .from('competitor_ads')
        .select(
          'id, project_id, brand_id, name, headline, hook, body_text, media_type, file_path, is_winner, ad_active, ad_started_at, spend, impressions, created_at',
        )
        .eq('project_id', id)
        .eq('brand_id', brandId)
        .order('created_at', { ascending: false })
        .limit(500);
      if (lean.error) return NextResponse.json({ error: lean.error.message }, { status: 500 });
      return NextResponse.json(
        tagNewAds((lean.data || []) as { brand_id: number; created_at?: string }[], seenAt),
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // is_new lets the grid badge whatever the daily scrape added since the last
  // visit; the client stamps the brand as seen once it has rendered them.
  return NextResponse.json(tagNewAds((data || []) as { brand_id: number; created_at?: string }[], seenAt));
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
    origin: new URL(req.url).origin,
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
