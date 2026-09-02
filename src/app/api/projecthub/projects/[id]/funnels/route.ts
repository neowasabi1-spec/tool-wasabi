import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import {
  archiveStepCount,
  dedupeStepsByUrl,
  mergeWalkFunnels,
} from '@/lib/archive-placement';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Selectable funnels for Chimera / Autopilot.
 *
 * Same pool as Templates → Funnel:
 *   - this project's competitor funnels
 *   - the shared Templates library (every project_id-null funnel)
 *
 * Walk-style rows ("<domain> — Step N") are folded into one funnel.
 * Single pages are excluded.
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

const UPSELL_RE = /upsell|downsell|\boto\b|bump/i;
const SELECT_COLS = 'id, name, steps, total_steps, project_id, created_at, section';
/** Multi-step folders OR old walk singles — never the whole page dump. */
const FUNNEL_CANDIDATE = 'total_steps.gte.2,name.ilike.%Step%';

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
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const queries = [
    supabaseAdmin
      .from('archived_funnels')
      .select(SELECT_COLS)
      .eq('project_id', id)
      .or(FUNNEL_CANDIDATE)
      .order('created_at', { ascending: false })
      .limit(400),
    supabaseAdmin
      .from('archived_funnels')
      .select(SELECT_COLS)
      .is('project_id', null)
      .or(FUNNEL_CANDIDATE)
      .order('created_at', { ascending: false })
      .limit(800),
  ];

  const results = await Promise.all(queries);
  const firstErr = results.find((r) => r.error)?.error;
  if (firstErr) return NextResponse.json({ error: firstErr.message }, { status: 500 });

  const byId = new Map<string, ArchiveRow>();
  for (const res of results) {
    for (const row of (res.data || []) as ArchiveRow[]) {
      if (!byId.has(row.id)) {
        byId.set(row.id, { ...row, steps: slimSteps(row.steps) });
      }
    }
  }

  const funnels = mergeWalkFunnels([...byId.values()])
    .filter((row) => row.section !== 'page')
    .map((row) => {
      const raw = Array.isArray(row.steps) ? (row.steps as Record<string, unknown>[]) : [];
      const steps = dedupeStepsByUrl(raw);
      const upsells = steps.filter((s) =>
        UPSELL_RE.test(String(s?.page_type || s?.step_type || '')),
      ).length;
      const totalSteps = Math.max(steps.length, archiveStepCount(row));
      return {
        id: row.id,
        name: row.name || 'Funnel',
        totalSteps,
        upsells,
        products: 1 + upsells,
        isProject: row.project_id === id,
        created_at: row.created_at,
      };
    })
    .filter((f) => f.upsells > 0 || (f.totalSteps || 0) >= 2)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return NextResponse.json(funnels);
}
