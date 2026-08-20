import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Selectable funnels for the Autopilot launcher.
 *
 *   GET /api/projecthub/projects/:id/funnels
 *       → the multi-step funnels available to this project (its own saved
 *         funnels + the shared funnel library), each with a derived product
 *         count: 1 main + one per upsell/downsell page.
 *
 * The final Autopilot step READS the selected funnel's steps to know how many
 * product images to generate — the number is never typed in or guessed.
 */

interface ArchiveStep { name?: string; page_type?: string; step_type?: string }
interface ArchiveRow {
  id: string;
  name: string;
  steps: ArchiveStep[] | null;
  total_steps: number | null;
  project_id: string | null;
  created_at: string;
}

const UPSELL_RE = /upsell|downsell|\boto\b|bump/i;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Project-owned funnels + the shared library (section='funnel'), multi-step
  // only so single-page competitor landings don't clutter the picker.
  const { data, error } = await supabaseAdmin
    .from('archived_funnels')
    .select('id, name, steps, total_steps, project_id, created_at')
    .or(`project_id.eq.${id},section.eq.funnel`)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const funnels = ((data || []) as ArchiveRow[])
    .map((row) => {
      const steps = Array.isArray(row.steps) ? row.steps : [];
      const upsells = steps.filter((s) => UPSELL_RE.test(String(s?.page_type || s?.step_type || ''))).length;
      return {
        id: row.id,
        name: row.name || 'Funnel',
        totalSteps: row.total_steps ?? steps.length,
        upsells,
        products: 1 + upsells,
        isProject: row.project_id === id,
        created_at: row.created_at,
      };
    })
    // Keep real multi-step funnels (with at least one upsell, or 2+ pages).
    .filter((f) => f.upsells > 0 || (f.totalSteps || 0) >= 2);

  return NextResponse.json(funnels);
}
