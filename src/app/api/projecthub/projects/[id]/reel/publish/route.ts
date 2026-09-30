import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import {
  publishReelUploadToWasabi,
  probeDurationSec,
} from '@/lib/reel/publish';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/projecthub/projects/:id/reel/publish
 * multipart: video (required), thumb (optional), brandId, name, script, voice, language
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('multipart/form-data')) {
    return NextResponse.json(
      { error: 'Use multipart/form-data with field "video" (final mp4)' },
      { status: 400 },
    );
  }

  const form = await req.formData();
  const video = form.get('video');
  if (!(video instanceof Blob)) {
    return NextResponse.json({ error: 'Missing video file' }, { status: 400 });
  }

  const thumbField = form.get('thumb');
  const thumb =
    thumbField instanceof Blob && thumbField.size > 0
      ? Buffer.from(await thumbField.arrayBuffer())
      : null;

  const brandRaw = form.get('brandId');
  const brandId =
    brandRaw != null && Number.isFinite(Number(brandRaw))
      ? Number(brandRaw)
      : undefined;

  const name = String(form.get('name') || '').trim() || undefined;
  const script = String(form.get('script') || '').trim() || null;
  const voice = String(form.get('voice') || '').trim() || null;
  const language = String(form.get('language') || '').trim() || null;
  const durationRaw = form.get('durationSec');
  let durationSec =
    durationRaw != null && Number.isFinite(Number(durationRaw))
      ? Number(durationRaw)
      : undefined;

  const videoBuf = Buffer.from(await video.arrayBuffer());

  if (durationSec == null || durationSec <= 0) {
    const tmp = join(tmpdir(), `reel-publish-${Date.now()}.mp4`);
    try {
      await writeFile(tmp, videoBuf);
      durationSec = await probeDurationSec(tmp);
    } catch {
      durationSec = 0;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  try {
    const result = await publishReelUploadToWasabi({
      projectId: id,
      video: videoBuf,
      thumb,
      brandId,
      name,
      script,
      voice,
      language,
      durationSec,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
