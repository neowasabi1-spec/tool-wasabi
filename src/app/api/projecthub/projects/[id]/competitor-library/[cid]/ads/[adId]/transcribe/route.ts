import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { transcribeVideoAnySize } from '@/lib/transcribe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const BUCKET = 'project-files';

/**
 * POST /api/projecthub/projects/:id/competitor-library/:cid/ads/:adId/transcribe
 * On-demand transcription for a saved video creative (handles long videos via
 * the Gemini File API). Stores the transcript in body_text and returns it.
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

  // Load the bytes: remote URL → fetch; storage path → download from bucket.
  let buffer: Buffer | null = null;
  let contentType = 'video/mp4';
  try {
    if (/^https?:\/\//i.test(ad.file_path)) {
      const r = await fetch(ad.file_path);
      if (r.ok) {
        contentType = r.headers.get('content-type') || contentType;
        buffer = Buffer.from(await r.arrayBuffer());
      }
    } else {
      const { data: blob } = await supabaseAdmin.storage.from(BUCKET).download(ad.file_path);
      if (blob) {
        contentType = blob.type || contentType;
        buffer = Buffer.from(await blob.arrayBuffer());
      }
    }
  } catch {
    /* fall through to error below */
  }

  if (!buffer || buffer.length === 0) {
    return NextResponse.json({ error: 'Could not load the video bytes' }, { status: 502 });
  }

  const transcript = await transcribeVideoAnySize(buffer, contentType);
  if (!transcript) {
    return NextResponse.json({ error: 'Transcription produced no text' }, { status: 502 });
  }

  const body_text = transcript.slice(0, 4000);
  await supabaseAdmin.from('competitor_ads').update({ body_text }).eq('id', ad.id);

  return NextResponse.json({ ok: true, body_text });
}
