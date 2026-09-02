import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { pickerFunnelsFromArchive } from '@/lib/archive-placement';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Funnel picker for Chimera — the same Templates → Funnel list every
 * user already sees, plus this project's own multi-step funnels if the
 * caller can access the project.
 */

interface ArchiveStep {
  name?: string;
  page_type?: string;
  step_type?: string;
  url_to_swipe?: unknown;
  cloned_data?: { source_url?: unknown } | null;
}

interface ArchiveRow {
  id: string;
  name: string;
  steps: ArchiveStep[] | null;
  total_steps: number | null;
  project_id: string | null;
  created_at: string;
  section?: string | null;
}

const SELECT_COLS = 'id, name, steps, total_steps, project_id, created_at, section';

function slimSteps(steps: unknown): ArchiveStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const s = raw as Record<string, unknown>;
    const cd =
      s.cloned_data && typeof s.cloned_data === 'object' && !Array.isArray(s.cloned_data)
        ? (s.cloned_data as Record<string, unknown>)
        : {};
    return {
      name: typeof s.name === 'string' ? s.name : undefined,
      page_type: typeof s.page_type === 'string' ? s.page_type : undefined,
      step_type: typeof s.step_type === 'string' ? s.step_type : undefined,
      url_to_swipe: s.url_to_swipe,
      cloned_data: { source_url: cd.source_url },
    };
  });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const ctx = await getUserAccessContext(req);
  if (!ctx.userId && !ctx.isMaster) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Templates library is shared — do not 404 just because this user is
  // not the project owner. Project-owned funnels are extra, only if allowed.
  const { allowed } = await canAccessProject(req, id);

  const libraryQ = supabaseAdmin
    .from('archived_funnels')
    .select(SELECT_COLS)
    .is('project_id', null)
    .order('created_at', { ascending: false })
    .limit(1000);

  const projectQ = allowed
    ? supabaseAdmin
        .from('archived_funnels')
        .select(SELECT_COLS)
        .eq('project_id', id)
        .order('created_at', { ascending: false })
        .limit(400)
    : Promise.resolve({ data: [] as ArchiveRow[], error: null });

  const [libRes, projRes] = await Promise.all([libraryQ, projectQ]);
  if (libRes.error) return NextResponse.json({ error: libRes.error.message }, { status: 500 });
  if (projRes.error) return NextResponse.json({ error: projRes.error.message }, { status: 500 });

  const byId = new Map<string, ArchiveRow>();
  for (const row of [...(libRes.data || []), ...(projRes.data || [])] as ArchiveRow[]) {
    if (!byId.has(row.id)) byId.set(row.id, { ...row, steps: slimSteps(row.steps) });
  }

  return NextResponse.json(pickerFunnelsFromArchive([...byId.values()], id));
}
