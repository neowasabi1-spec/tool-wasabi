import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/projecthub/projects/:id/competitor-library/creatives
 * All competitor creatives for the project (flat), each tagged with its
 * competitor brand id + name. Powers the "All creatives" view.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [{ data: ads, error }, { data: brands }] = await Promise.all([
    supabaseAdmin
      .from('competitor_ads')
      .select('*')
      .eq('project_id', id)
      .order('created_at', { ascending: false }),
    supabaseAdmin.from('competitor_brands').select('id, name').eq('project_id', id),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const nameById = new Map<number, string>();
  for (const b of (brands || []) as { id: number; name: string }[]) nameById.set(b.id, b.name);

  const result = ((ads || []) as { brand_id: number }[]).map((a) => ({
    ...a,
    brand_name: nameById.get(a.brand_id) || '',
  }));

  return NextResponse.json(result);
}
