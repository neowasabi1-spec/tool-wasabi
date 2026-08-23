import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Competitor Landings — the saved competitor landing pages of a project.
 *
 *   GET /api/projecthub/projects/:id/landings
 *       → list the `archived_funnels` rows linked to this project (project_id),
 *         shaped for the Competitor Library "Landings" grid (preview shot,
 *         source URL, view-HTML + open-in-editor links).
 *
 * Landings are captured by the browser extension (save-page with a projectId)
 * or by the app itself. Each is a single-step archive row; its HTML/screenshots
 * live in the step's `cloned_data`, so we reuse the same preview + /edit infra
 * as the global archive.
 */

interface StepClonedData {
  html?: string;
  title?: string;
  source_url?: string;
  screenshotDesktopUrl?: string | null;
  screenshotMobileUrl?: string | null;
  htmlUrl?: string;
  category?: string;
  tags?: string[];
}

interface ArchiveStep {
  page_type?: string;
  name?: string;
  step_index?: number;
  page_id?: string;
  cloned_data?: StepClonedData;
}

interface ArchiveRow {
  id: string;
  name: string;
  steps: ArchiveStep[] | null;
  created_at: string;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from('archived_funnels')
    .select('id, name, steps, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Each archived_funnels row is a funnel "folder"; expand its steps into one
  // landing card per step. Single-step rows (legacy / one-off saves) yield a
  // single card with the plain row id, so their existing delete/edit links keep
  // working; multi-step folders use a composite id `${rowId}::${index}`.
  const landings = ((data || []) as ArchiveRow[]).flatMap((row) => {
    const steps = Array.isArray(row.steps) ? row.steps : [];
    if (!steps.length) return [];
    const multi = steps.length > 1;
    return steps.map((step, i) => {
      const cd = step?.cloned_data || {};
      const keyId = step?.page_id || row.id;
      return {
        id: multi ? `${row.id}::${i}` : row.id,
        name: step?.name || row.name,
        url: cd.source_url || '',
        page_type: step?.page_type || 'landing',
        // Group every step of a folder together in the Competitor Library.
        category: cd.category || row.name || '',
        tags: Array.isArray(cd.tags) ? cd.tags : [],
        screenshot: cd.screenshotDesktopUrl || cd.screenshotMobileUrl || '',
        screenshot_desktop: cd.screenshotDesktopUrl || '',
        screenshot_mobile: cd.screenshotMobileUrl || '',
        html_url:
          cd.htmlUrl ||
          `/api/funnel-html?pageId=${encodeURIComponent(keyId)}&kind=cloned&variant=desktop`,
        editor_url: `/edit/${keyId}`,
        created_at: row.created_at,
      };
    });
  });

  return NextResponse.json(landings);
}
