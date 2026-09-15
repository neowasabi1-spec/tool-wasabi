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
 * Enqueue a video for one creative.
 *
 * mode 'localize' (the creative panel): keep the cleaned footage when it
 *   exists (else the original), swap in a voiceover + burned subtitles.
 *   Copy is either the pasted `script` or the creative's transcript.
 * mode 'build' (legacy / compose): assemble a new video from the project's real
 *   shot pool, driven by the creative's script or a pasted copy.
 *
 * POST body: { mode?: 'localize' | 'build'; voice?: string; language?: string; script?: string }
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
  const mode = body.mode === 'build' ? 'build' : 'localize';

  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, rewritten_script, body_text, file_path, media_type, clean_full_path')
    .eq('id', adIdNum)
    .eq('brand_id', brandIdNum)
    .eq('project_id', id)
    .maybeSingle();
  if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });

  const a = ad as {
    rewritten_script?: string; body_text?: string;
    file_path?: string; media_type?: string; clean_full_path?: string | null;
  };

  // Localize dubs the cleaned video when one exists, otherwise the original.
  // Copy can be pasted (`script`) or fall back to the creative's transcript.
  if (mode === 'localize') {
    const sourcePath = String(a.clean_full_path || a.file_path || '').trim();
    if (a.media_type !== 'video' || !sourcePath) {
      return NextResponse.json({ error: 'Localize needs a video — this creative has none.' }, { status: 400 });
    }
    const transcript = String(a.body_text || a.rewritten_script || '').trim();
    const usingCustomCopy = customCopy.length >= 20;
    const copy = usingCustomCopy ? customCopy : transcript;
    if (copy.length < 20) {
      return NextResponse.json({
        error: usingCustomCopy
          ? 'Paste a bit more copy (min ~20 chars).'
          : 'No transcript yet. Click “Extract text” first, or paste your own copy below.',
      }, { status: 400 });
    }

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
        }, 'localize-video-background');
      }
      return NextResponse.json({ jobId: active.id, status: active.status, queued: false });
    }

    const scenes = await splitScriptToScenes(copy, language);
    if (scenes.length === 0) {
      return NextResponse.json({ error: 'Could not split the copy into lines' }, { status: 500 });
    }

    const job = await insertBuildJob({
      project_id: id, brand_id: brandIdNum, ad_id: adIdNum,
      voice, scenes, language: language || null, mode: 'localize', source_path: sourcePath,
    });
    if (!job) return NextResponse.json({ error: 'Failed to queue localize' }, { status: 500 });

    await triggerBuildBackground(new URL(req.url).origin, {
      jobId: job.id, projectId: id, brandId: brandIdNum, adId: adIdNum,
    }, 'localize-video-background');

    return NextResponse.json({
      jobId: job.id, status: job.status, scenes: scenes.length,
      language: language || null, mode: 'localize', queued: true,
      usedClean: Boolean(a.clean_full_path),
      usedCustomCopy: usingCustomCopy,
    });
  }

  // mode 'build' — assemble from the shot pool.
  const script = (customCopy ||
    String(a.rewritten_script || a.body_text || '')).trim();
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
    voice, scenes, language: language || null, mode: 'build',
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
