import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { enqueueSegmentation } from '@/lib/segment-enqueue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/projecthub/projects/:id/shots/recut-clean
 *
 * Cheap redo: re-cut shots from videos that already have a cleaned full file
 * (competitor_ads.clean_full_path). ffmpeg + scene vision only — no Replicate
 * per clip, because the pixels are already clean.
 *
 * Videos that were never whole-cleaned are skipped (those still need one
 * "Remove subtitles" pass on the full ad, not N shot inpaints).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let q = await supabaseAdmin
    .from('competitor_ads')
    .select('id, brand_id, media_type, clean_full_path')
    .eq('project_id', id)
    .eq('media_type', 'video');
  if (q.error && /clean_full_path/i.test(q.error.message || '')) {
    return NextResponse.json({
      queued: 0,
      skipped: 0,
      message: 'No cleaned full videos yet. Run “Remove subtitles (whole video)” once per ad, then recut.',
    });
  }
  if (q.error) return NextResponse.json({ error: q.error.message }, { status: 500 });

  const ads = (q.data || []).filter((a) => String(a.clean_full_path || '').trim());
  if (!ads.length) {
    return NextResponse.json({
      queued: 0,
      skipped: (q.data || []).length,
      message: 'No cleaned full videos yet. Clean each video once, then recut from those files.',
    });
  }

  const origin = new URL(req.url).origin;
  let queued = 0;
  for (const ad of ads.slice(0, 40)) {
    const r = await enqueueSegmentation({
      projectId: id,
      brandId: Number(ad.brand_id),
      adId: Number(ad.id),
      origin,
    });
    if (r.queued || r.jobId) queued += 1;
  }

  return NextResponse.json({
    queued,
    skipped: Math.max(0, (q.data || []).length - ads.length),
    cleanedAds: ads.length,
  });
}
