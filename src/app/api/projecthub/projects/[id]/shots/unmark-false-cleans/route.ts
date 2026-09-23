import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { backgroundOrigin } from '@/lib/segment-enqueue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST — compare stored "clean" files to the original and clear the mark
 * when the captions are still there. ffmpeg only, no Replicate.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const origin = backgroundOrigin(new URL(req.url).origin);
  try {
    await fetch(`${origin}/.netlify/functions/inpaint-shot-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audit: true, projectId: id }),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
