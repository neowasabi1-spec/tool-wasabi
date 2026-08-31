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

// While a job is queued/running, clean_error holds an opaque `__ts:<ms>` stamp
// (set here on queue, refreshed by the background fn on claim). Netlify kills
// background functions at 15 min without warning, so a run can die leaving
// clean_status stuck — the stamp lets us detect and self-heal that.
const STALE_PROCESSING_MS = 16 * 60 * 1000;
const STALE_PENDING_MS = 3 * 60 * 1000;

function isTsStamp(v: string | null | undefined) {
  return /^__ts:\d+$/.test(v || '');
}

function isStale(status: string | null | undefined, cleanError: string | null | undefined) {
  if (status !== 'processing' && status !== 'pending') return false;
  const m = /^__ts:(\d+)$/.exec(cleanError || '');
  if (!m) return true; // in-flight status without a stamp = leftover from a dead run
  const age = Date.now() - Number(m[1]);
  return age > (status === 'processing' ? STALE_PROCESSING_MS : STALE_PENDING_MS);
}

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
    .select('id, media_type, clean_status, clean_error')
    .eq('id', adIdNum)
    .eq('brand_id', brandIdNum)
    .eq('project_id', id)
    .maybeSingle();
  if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });
  if ((ad as { media_type?: string }).media_type !== 'video') {
    return NextResponse.json({ error: 'Only video creatives can be cleaned' }, { status: 400 });
  }

  // Don't double-run while one is genuinely in flight — but a stale
  // "processing" (the background run was killed) must be re-queueable.
  const status = (ad as { clean_status?: string }).clean_status;
  const cleanError = (ad as { clean_error?: string }).clean_error;
  if (status === 'processing' && !isStale(status, cleanError)) {
    return NextResponse.json({ status: 'processing', queued: false });
  }

  const { error } = await supabaseAdmin
    .from('competitor_ads')
    .update({ clean_status: 'pending', clean_error: `__ts:${Date.now()}` })
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

  let status = (ad as { clean_status?: string })?.clean_status || null;
  const cleanPath = (ad as { clean_full_path?: string })?.clean_full_path || null;
  let error = (ad as { clean_error?: string })?.clean_error || null;

  // Self-heal: a run that died mid-flight leaves 'processing'/'pending'
  // forever. Flip it to a retryable error the moment anyone looks at it.
  if (isStale(status, error)) {
    // If an earlier run already produced a cleaned video, just surface it.
    if (cleanPath) {
      status = 'done';
      error = null;
    } else {
      status = 'error';
      error = 'Cleaning timed out — click Remove subtitles to retry.';
    }
    await supabaseAdmin
      .from('competitor_ads')
      .update({ clean_status: status, clean_error: error })
      .eq('id', adIdNum)
      .eq('project_id', id);
  }

  return NextResponse.json({
    status,
    cleanPath,
    error: isTsStamp(error) ? null : error,
  });
}
