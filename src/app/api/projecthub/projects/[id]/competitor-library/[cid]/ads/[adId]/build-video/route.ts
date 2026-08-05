import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import {
  countUsableShots, insertBuildJob, normalizeLanguage, normalizeVoice,
  splitScriptToScenes, triggerBuildBackground,
} from '@/lib/video-build';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * Phase 2 step 2 — enqueue "build a new video from the project's real shot pool".
 *
 * The script is either the creative's own (rewritten) copy or a custom copy the
 * user pastes in, optionally localized into another language. It is split into
 * spoken beats and queued as a video_build_jobs row for the ffmpeg+TTS worker;
 * the same product footage is reused whatever the copy or language.
 *
 * POST body: { voice?: string; script?: string; language?: string }
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

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const voice = normalizeVoice(body.voice);
  const language = normalizeLanguage(body.language);
  const customCopy = String(body.script ?? '').trim();

  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, rewritten_script, body_text')
    .eq('id', adIdNum)
    .eq('brand_id', brandIdNum)
    .eq('project_id', id)
    .maybeSingle();
  if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });

  // A pasted copy wins over the creative's own script; otherwise fall back to
  // the rewritten script and finally the raw ad copy.
  const script = (customCopy ||
    String(
      (ad as { rewritten_script?: string }).rewritten_script ||
        (ad as { body_text?: string }).body_text ||
        '',
    )).trim();
  if (script.length < 30) {
    return NextResponse.json(
      { error: 'No script yet. Paste your own copy, or generate “my script” / transcribe first.' },
      { status: 400 },
    );
  }

  const usableCount = await countUsableShots(id);
  if (!usableCount) {
    return NextResponse.json(
      { error: 'No usable shots: every shot has burned-in subtitles. Use “Remove subs (AI)” in the Shots tab, upload clean clips in My Footage, or split a subtitle-free video.' },
      { status: 400 },
    );
  }

  // Don't double-queue for the same creative.
  const { data: active } = await supabaseAdmin
    .from('video_build_jobs')
    .select('id, status')
    .eq('ad_id', adIdNum)
    .in('status', ['pending', 'processing'])
    .maybeSingle();
  if (active?.id) {
    if (active.status === 'pending') {
      await triggerBuildBackground(new URL(req.url).origin, {
        jobId: active.id, projectId: id, brandId: brandIdNum, adId: adIdNum,
      });
    }
    return NextResponse.json({ jobId: active.id, status: active.status, queued: false });
  }

  const scenes = await splitScriptToScenes(script, language);
  if (scenes.length === 0) {
    return NextResponse.json({ error: 'Could not split the script into scenes' }, { status: 500 });
  }

  const job = await insertBuildJob({
    project_id: id, brand_id: brandIdNum, ad_id: adIdNum,
    voice, scenes, language: language || null,
  });
  if (!job) {
    return NextResponse.json({ error: 'Failed to queue build' }, { status: 500 });
  }

  await triggerBuildBackground(new URL(req.url).origin, {
    jobId: job.id, projectId: id, brandId: brandIdNum, adId: adIdNum,
  });

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    scenes: scenes.length,
    language: language || null,
    queued: true,
  });
}

/**
 * Give up on a build that is stuck.
 *
 * The assembly runs in a background function, and if that function dies without
 * writing an outcome the row stays 'processing' and the button spins forever with
 * no way out. Marking it canceled releases the UI and lets a new build start; a
 * function that is somehow still alive will just finish and save its video.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; adId: string } },
) {
  const { id, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const adIdNum = Number(adId);
  if (!Number.isFinite(adIdNum)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('video_build_jobs')
    .update({
      status: 'canceled',
      error: 'Canceled',
      finished_at: new Date().toISOString(),
    })
    .eq('project_id', id)
    .eq('ad_id', adIdNum)
    .in('status', ['pending', 'processing'])
    .select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ canceled: (data || []).length });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; cid: string; adId: string } },
) {
  const { id, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const adIdNum = Number(adId);
  if (!Number.isFinite(adIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const [{ data: job }, { data: videos }] = await Promise.all([
    supabaseAdmin
      .from('video_build_jobs')
      .select('id, status, error, created_at, finished_at')
      .eq('ad_id', adIdNum)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('generated_videos')
      .select('*')
      .eq('ad_id', adIdNum)
      .order('created_at', { ascending: false }),
  ]);

  return NextResponse.json({ job: job || null, videos: videos || [] });
}
