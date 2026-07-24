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

  const landings = ((data || []) as ArchiveRow[]).map((row) => {
    const step = Array.isArray(row.steps) ? row.steps[0] : undefined;
    const cd = step?.cloned_data || {};
    return {
      id: row.id,
      name: row.name,
      url: cd.source_url || '',
      page_type: step?.page_type || 'landing',
      category: cd.category || '',
      tags: Array.isArray(cd.tags) ? cd.tags : [],
      screenshot: cd.screenshotDesktopUrl || cd.screenshotMobileUrl || '',
      html_url:
        cd.htmlUrl ||
        `/api/funnel-html?pageId=${encodeURIComponent(row.id)}&kind=cloned&variant=desktop`,
      editor_url: `/edit/${row.id}`,
      created_at: row.created_at,
    };
  });

  return NextResponse.json(landings);
}
