import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(req: NextRequest, { params }: { params: { id: string; aid: string } }) {
  const { id, aid } = params;
  const { allowed } = await canAccessProject(req, id);
  const n = Number(aid);
  if (!allowed || !Number.isFinite(n)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { error } = await supabaseAdmin
    .from('creative_angles')
    .delete()
    .eq('project_id', id)
    .eq('id', n);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
