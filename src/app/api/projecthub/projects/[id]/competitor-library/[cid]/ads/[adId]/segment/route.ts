import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Phase 2 — enqueue "split this competitor video into shots".
 *
 * POST → queue a video_segment_jobs row for the local ffmpeg worker.
 * GET  → latest job status + how many shots exist for this creative.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; cid: string; adId: string } },
) {
  const { id, cid, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const adIdNum = Number(adId);
  const brandIdNum = Number(cid);
  if (!Number.isFinite(adIdNum) || !Number.isFinite(brandIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, media_type, file_path')
    .eq('id', adIdNum)
    .eq('brand_id', brandIdNum)
    .eq('project_id', id)
    .maybeSingle();
  if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });
  if ((ad as { media_type?: string }).media_type !== 'video') {
    return NextResponse.json({ error: 'Only video creatives can be split into shots' }, { status: 400 });
  }

  // Don't double-queue if a job is already pending/processing for this ad.
  const { data: active } = await supabaseAdmin
    .from('video_segment_jobs')
    .select('id, status')
    .eq('ad_id', adIdNum)
    .in('status', ['pending', 'processing'])
    .maybeSingle();
  if (active?.id) {
    return NextResponse.json({ jobId: active.id, status: active.status, queued: false });
  }

  const { data: job, error } = await supabaseAdmin
    .from('video_segment_jobs')
    .insert({ project_id: id, brand_id: brandIdNum, ad_id: adIdNum, status: 'pending' })
    .select('id, status')
    .single();
  if (error || !job) {
    return NextResponse.json({ error: error?.message || 'Failed to queue job' }, { status: 500 });
  }

  return NextResponse.json({ jobId: job.id, status: job.status, queued: true });
}

export async function GET(
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

  const [{ data: job }, { count }] = await Promise.all([
    supabaseAdmin
      .from('video_segment_jobs')
      .select('id, status, error, shots_count, created_at, finished_at')
      .eq('ad_id', adIdNum)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('competitor_shots')
      .select('id', { count: 'exact', head: true })
      .eq('ad_id', adIdNum),
  ]);

  return NextResponse.json({ job: job || null, shots: count || 0 });
}
