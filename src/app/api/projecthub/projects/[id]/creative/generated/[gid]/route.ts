import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PUT(req: NextRequest, { params }: { params: { id: string; gid: string } }) {
  const { id, gid } = params;
  const { allowed } = await canAccessProject(req, id);
  const n = Number(gid);
  if (!allowed || !Number.isFinite(n)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const update: Record<string, unknown> = {};
  if (typeof body.status === 'string') update.status = body.status;
  if (typeof body.headline === 'string') update.headline = body.headline;
  if (typeof body.hook === 'string') update.hook = body.hook;
  if (typeof body.body === 'string') update.body = body.body;
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No allowed fields' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('creative_generated')
    .update(update)
    .eq('project_id', id)
    .eq('id', n)
    .select('*')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; gid: string } }) {
  const { id, gid } = params;
  const { allowed } = await canAccessProject(req, id);
  const n = Number(gid);
  if (!allowed || !Number.isFinite(n)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { error } = await supabaseAdmin
    .from('creative_generated')
    .delete()
    .eq('project_id', id)
    .eq('id', n);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
