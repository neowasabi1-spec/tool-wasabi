import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Whole-video subtitle removal for a competitor creative.
 *
 * POST → mark the ad clean_status='pending' and fire inpaint-shot-background
 *        with { adId } so it cleans the FULL video (captions removed, original
 *        audio kept) and stores the result in competitor_ads.clean_full_path.
 * GET  → current clean_status + cleaned path.
 */

async function triggerBackground(origin: string, payload: { adId: number; projectId: string }) {
  try {
    await fetch(`${origin}/.netlify/functions/inpaint-shot-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('[clean-video] background trigger failed:', (e as Error).message);
  }
}

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
    .select('id, media_type, clean_status')
    .eq('id', adIdNum)
    .eq('brand_id', brandIdNum)
    .eq('project_id', id)
    .maybeSingle();
  if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });
  if ((ad as { media_type?: string }).media_type !== 'video') {
    return NextResponse.json({ error: 'Only video creatives can be cleaned' }, { status: 400 });
  }

  // Don't double-run while one is in flight.
  if ((ad as { clean_status?: string }).clean_status === 'processing') {
    return NextResponse.json({ status: 'processing', queued: false });
  }

  const { error } = await supabaseAdmin
    .from('competitor_ads')
    .update({ clean_status: 'pending', clean_error: null })
    .eq('id', adIdNum)
    .eq('project_id', id);
  if (error) {
    const missing = /clean_status|clean_full_path/i.test(error.message);
    return NextResponse.json(
      { error: missing ? 'Run supabase-migration-ad-clean.sql first' : error.message },
      { status: 500 },
    );
  }

  await triggerBackground(new URL(req.url).origin, { adId: adIdNum, projectId: id });
  return NextResponse.json({ status: 'pending', queued: true });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; cid: string; adId: string } },
) {
  const { id, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const adIdNum = Number(adId);
  if (!Number.isFinite(adIdNum)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('clean_status, clean_full_path, clean_error')
    .eq('id', adIdNum)
    .eq('project_id', id)
    .maybeSingle();

  return NextResponse.json({
    status: (ad as { clean_status?: string })?.clean_status || null,
    cleanPath: (ad as { clean_full_path?: string })?.clean_full_path || null,
    error: (ad as { clean_error?: string })?.clean_error || null,
  });
}
