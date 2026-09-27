import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from('ads_intel_jobs')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    return NextResponse.json(
      {
        error:
          error.message +
          (/ads_intel_jobs/i.test(error.message)
            ? ' Apply supabase-migration-ads-intel.sql on DEV Supabase.'
            : ''),
      },
      { status: 500 },
    );
  }
  return NextResponse.json({ jobs: data || [] });
}
