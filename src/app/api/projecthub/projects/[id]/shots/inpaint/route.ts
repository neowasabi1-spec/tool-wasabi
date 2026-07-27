import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { backgroundOrigin } from '@/lib/segment-enqueue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/projecthub/projects/:id/shots/inpaint
 * Remove burned-in subtitles from shots with AI video inpainting (Replicate).
 * Body: { shotId } for a single shot, or { all: true } for every subtitled
 * shot that hasn't been cleaned yet. Marks rows pending and fires one
 * background function per shot.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!process.env.REPLICATE_API_TOKEN) {
    return NextResponse.json(
      { error: 'REPLICATE_API_TOKEN is not configured. Add it in Netlify env vars (get one at replicate.com) to enable AI subtitle removal.' },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const shotId = Number(body.shotId);
  const all = body.all === true;
  if (!all && !Number.isFinite(shotId)) {
    return NextResponse.json({ error: 'shotId or all:true required' }, { status: 400 });
  }

  let q = supabaseAdmin
    .from('competitor_shots')
    .select('id, inpaint_status, clean_path, has_text')
    .eq('project_id', id);
  q = all ? q.eq('has_text', true) : q.eq('id', shotId);
  const { data, error } = await q;
  if (error) {
    if (/inpaint|clean_path/i.test(error.message)) {
      return NextResponse.json(
        { error: 'Database migration missing: run supabase-migration-shot-inpaint.sql first.' },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Skip already-cleaned and currently-processing shots; re-queue errors.
  const targets = (data || []).filter(
    (s) => !s.clean_path && s.inpaint_status !== 'processing',
  );
  if (targets.length === 0) {
    return NextResponse.json({ queued: 0, message: 'Nothing to clean' });
  }

  const ids = targets.map((s) => s.id as number);
  const { error: updErr } = await supabaseAdmin
    .from('competitor_shots')
    .update({ inpaint_status: 'pending', inpaint_error: null })
    .in('id', ids);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  const origin = backgroundOrigin(new URL(req.url).origin);
  await Promise.allSettled(
    ids.map((sid) =>
      fetch(`${origin}/.netlify/functions/inpaint-shot-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId: sid, projectId: id }),
      }),
    ),
  );

  return NextResponse.json({ queued: ids.length });
}
