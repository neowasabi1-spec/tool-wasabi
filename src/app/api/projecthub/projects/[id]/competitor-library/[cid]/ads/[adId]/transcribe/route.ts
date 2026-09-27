import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { ensureTranscriptColumn, readCompetitorTranscript, writeCompetitorTranscript } from '@/lib/competitor-ads';
import { backgroundOrigin } from '@/lib/segment-enqueue';
import { transcribeVideoAnySize } from '@/lib/transcribe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const BUCKET = 'project-files';

/**
 * POST starts transcription in the ffmpeg background function (the Next
 * handler has no ffmpeg, so Whisper rejected the raw mp4 and the button
 * always failed). GET is what the panel polls until the text is saved.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; cid: string; adId: string } },
) {
  const { id, cid, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, file_path, media_type, body_text')
    .eq('id', Number(adId))
    .eq('project_id', id)
    .eq('brand_id', Number(cid))
    .maybeSingle();

  if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });
  if (ad.media_type !== 'video') {
    return NextResponse.json({ error: 'Only videos can be transcribed' }, { status: 400 });
  }
  if (!ad.file_path) {
    return NextResponse.json({ error: 'No media stored for this creative' }, { status: 400 });
  }

  await ensureTranscriptColumn();
  await supabaseAdmin
    .from('competitor_ads')
    .update({ transcript_status: 'running', transcript_error: null })
    .eq('id', ad.id);

  const origin = backgroundOrigin(new URL(req.url).origin);
  let queued = false;
  try {
    const res = await fetch(`${origin}/.netlify/functions/transcribe-video-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: id, brandId: Number(cid), adId: Number(adId) }),
    });
    // 202 = background accepted. 404 = not deployed (local next dev) → fall back.
    queued = res.status !== 404 && res.status !== 405;
  } catch {
    queued = false;
  }

  if (queued) {
    return NextResponse.json({ ok: true, pending: true });
  }

  const spoken = await transcribeInline(ad.file_path);
  if (!spoken) {
    return NextResponse.json({ error: 'Transcription produced no text' }, { status: 502 });
  }
  await saveTranscript(id, ad.id, spoken);
  return NextResponse.json({ ok: true, transcript: spoken, body_text: ad.body_text || '' });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; cid: string; adId: string } },
) {
  const { id, cid, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('transcript, transcript_status, transcript_error')
    .eq('id', Number(adId))
    .eq('project_id', id)
    .eq('brand_id', Number(cid))
    .maybeSingle();

  if (error && /transcript|schema cache|42703|PGRST204/i.test(error.message || '')) {
    data = null;
    error = null;
  }
  const row = (data || {}) as { transcript?: string | null; transcript_status?: string | null; transcript_error?: string | null };
  let transcript = String(row.transcript || '').trim();
  if (!transcript) transcript = await readCompetitorTranscript(id, adId);
  const schemaNoise = /schema cache|Could not find the 'transcript' column/i.test(row.transcript_error || '');
  return NextResponse.json({
    transcript,
    status: transcript ? 'ready' : (schemaNoise ? '' : (row.transcript_status || '')),
    error: schemaNoise ? '' : (row.transcript_error || ''),
  });
}

async function transcribeInline(filePath: string): Promise<string> {
  let buffer: Buffer | null = null;
  let contentType = 'video/mp4';
  try {
    if (/^https?:\/\//i.test(filePath)) {
      const r = await fetch(filePath);
      if (r.ok) {
        contentType = r.headers.get('content-type') || contentType;
        buffer = Buffer.from(await r.arrayBuffer());
      }
    } else {
      const { data: blob } = await supabaseAdmin.storage.from(BUCKET).download(filePath);
      if (blob) {
        contentType = blob.type || contentType;
        buffer = Buffer.from(await blob.arrayBuffer());
      }
    }
  } catch {
    return '';
  }
  if (!buffer || buffer.length === 0) return '';
  return (await transcribeVideoAnySize(buffer, contentType)).trim();
}

async function saveTranscript(projectId: string, adId: number, spoken: string) {
  const text = spoken.slice(0, 8000);
  await writeCompetitorTranscript(projectId, adId, text);
  let { error } = await supabaseAdmin
    .from('competitor_ads')
    .update({ transcript: text, transcript_status: 'ready', transcript_error: null })
    .eq('id', adId);
  if (error && /transcript|schema cache|42703|PGRST204/i.test(error.message || '')) {
    await supabaseAdmin.from('competitor_ads').update({ transcript: text }).eq('id', adId);
  }
}
