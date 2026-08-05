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
 * Brand-level "create a custom video" — not tied to any single creative.
 *
 * The whole point is to reuse a product's real shot pool with copy the user
 * writes (or a competitor script localized into another language). Jobs are
 * stored against the brand with ad_id = 0, so they show up in New Creatives
 * tagged with the product name.
 *
 * POST body: { voice?: string; language?: string; script?: string; sourceAdId?: number }
 * At least one of `script` (pasted copy) or `sourceAdId` (script to localize) is required.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; cid: string } },
) {
  const { id, cid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const brandIdNum = Number(cid);
  if (!Number.isFinite(brandIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const voice = normalizeVoice(body.voice);
  const language = normalizeLanguage(body.language);
  let script = String(body.script ?? '').trim();

  // No pasted copy: localize a source creative's script instead.
  if (script.length < 30) {
    const sourceAdId = Number(body.sourceAdId);
    if (Number.isFinite(sourceAdId) && sourceAdId > 0) {
      const { data: ad } = await supabaseAdmin
        .from('competitor_ads')
        .select('rewritten_script, body_text')
        .eq('id', sourceAdId)
        .eq('project_id', id)
        .maybeSingle();
      script = String(
        (ad as { rewritten_script?: string } | null)?.rewritten_script ||
          (ad as { body_text?: string } | null)?.body_text ||
          '',
      ).trim();
    }
  }
  if (script.length < 30) {
    return NextResponse.json(
      { error: 'Paste your copy (or pick a source creative with a script to localize).' },
      { status: 400 },
    );
  }

  const usableCount = await countUsableShots(id);
  if (!usableCount) {
    return NextResponse.json(
      { error: 'No usable shots for this product yet: split subtitle-free videos, remove subtitles (AI), or upload clips in My Footage first.' },
      { status: 400 },
    );
  }

  const scenes = await splitScriptToScenes(script, language);
  if (scenes.length === 0) {
    return NextResponse.json({ error: 'Could not split the copy into scenes' }, { status: 500 });
  }

  const job = await insertBuildJob({
    project_id: id, brand_id: brandIdNum, ad_id: 0,
    voice, scenes, language: language || null,
  });
  if (!job) {
    return NextResponse.json({ error: 'Failed to queue build' }, { status: 500 });
  }

  await triggerBuildBackground(new URL(req.url).origin, {
    jobId: job.id, projectId: id, brandId: brandIdNum, adId: 0,
  });

  return NextResponse.json({
    jobId: job.id, status: job.status, scenes: scenes.length,
    language: language || null, queued: true,
  });
}

/** Latest custom build for this brand + the brand's generated videos, for polling. */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; cid: string } },
) {
  const { id, cid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const brandIdNum = Number(cid);
  if (!Number.isFinite(brandIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const [{ data: job }, { data: videos }] = await Promise.all([
    supabaseAdmin
      .from('video_build_jobs')
      .select('id, status, error, created_at, finished_at')
      .eq('project_id', id)
      .eq('brand_id', brandIdNum)
      .eq('ad_id', 0)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('generated_videos')
      .select('*')
      .eq('project_id', id)
      .eq('brand_id', brandIdNum)
      .order('created_at', { ascending: false }),
  ]);

  return NextResponse.json({ job: job || null, videos: videos || [] });
}
