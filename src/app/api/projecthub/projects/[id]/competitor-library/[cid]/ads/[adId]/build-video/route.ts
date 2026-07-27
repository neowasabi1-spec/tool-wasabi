import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

/** Fire the build background function (fire-and-forget; it responds 202). */
async function triggerBuildBackground(
  origin: string,
  payload: { jobId: number; projectId: string; brandId: number; adId: number },
) {
  try {
    await fetch(`${origin}/.netlify/functions/build-video-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('[build-video] background trigger failed:', (e as Error).message);
  }
}

const SPLIT_SYSTEM = `You split a short direct-response video ad script into an ordered list of spoken VOICEOVER lines for a vertical short-form video.

Rules:
- Each line = ONE on-screen beat, natural spoken cadence, ~4-14 words.
- Keep the persuasive order (hook → problem → solution/mechanism → proof → offer → CTA).
- Strip stage directions, brackets, "HOOK:", "CTA:", B-roll notes — output ONLY the words to be spoken.
- 6 to 12 lines total.
Return ONLY a compact JSON array of strings. No markdown, no explanation.`;

/**
 * Phase 2 step 2 — enqueue "build a new video from real competitor shots".
 * Splits the (rewritten) script into scenes via Claude and queues a
 * video_build_jobs row for the local ffmpeg+TTS worker.
 *
 * POST body: { voice?: string }
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
  const voice = OPENAI_VOICES.includes(String(body.voice)) ? String(body.voice) : 'alloy';

  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, rewritten_script, body_text')
    .eq('id', adIdNum)
    .eq('brand_id', brandIdNum)
    .eq('project_id', id)
    .maybeSingle();
  if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });

  const script = String(
    (ad as { rewritten_script?: string }).rewritten_script ||
      (ad as { body_text?: string }).body_text ||
      '',
  ).trim();
  if (script.length < 30) {
    return NextResponse.json(
      { error: 'No script yet. Generate “my script” (or transcribe) first.' },
      { status: 400 },
    );
  }

  // Every shot is usable: clean ones as-is, subtitled ones get the text band
  // erased (delogo) at build time. No AI-generated filler — so we DO block
  // when the project has zero shots at all.
  const { count: shotCount } = await supabaseAdmin
    .from('competitor_shots')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', id);
  if (!shotCount || shotCount === 0) {
    return NextResponse.json(
      { error: 'No shots in this project yet. Split a video into shots or upload clips in My Footage first.' },
      { status: 400 },
    );
  }

  // Don't double-queue.
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

  // Split the script into scenes with Claude.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });

  let scenes: { text: string }[] = [];
  try {
    const anthropic = new Anthropic({ apiKey });
    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1500,
      system: SPLIT_SYSTEM,
      messages: [{ role: 'user', content: script.slice(0, 6000) }],
    });
    const tb = resp.content.find((b) => b.type === 'text');
    const raw = (tb && 'text' in tb ? tb.text : '') || '';
    const clean = raw.replace(/```json?/gi, '').replace(/```/g, '').trim();
    const arr = JSON.parse(clean);
    if (Array.isArray(arr)) {
      scenes = arr
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean)
        .slice(0, 12)
        .map((text) => ({ text }));
    }
  } catch {
    // Fallback: naive split on sentence boundaries.
    scenes = script
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2)
      .slice(0, 12)
      .map((text) => ({ text }));
  }
  if (scenes.length === 0) {
    return NextResponse.json({ error: 'Could not split the script into scenes' }, { status: 500 });
  }

  const { data: job, error } = await supabaseAdmin
    .from('video_build_jobs')
    .insert({ project_id: id, brand_id: brandIdNum, ad_id: adIdNum, status: 'pending', voice, scenes })
    .select('id, status')
    .single();
  if (error || !job) {
    return NextResponse.json({ error: error?.message || 'Failed to queue build' }, { status: 500 });
  }

  // Fire the Netlify background function that does the ffmpeg+TTS assembly.
  await triggerBuildBackground(new URL(req.url).origin, {
    jobId: job.id, projectId: id, brandId: brandIdNum, adId: adIdNum,
  });

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    scenes: scenes.length,
    queued: true,
  });
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
