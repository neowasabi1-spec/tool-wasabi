import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { dedupeStepsByUrl } from '@/lib/archive-placement';
import { loadSlimArchivedFunnels, type SlimArchiveStep } from '@/lib/slim-archived-funnels';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

/**
 * Competitor Landings — the saved competitor landing pages of a project.
 *
 * Lists metadata only. Full HTML lives in `page_html`; pulling it from
 * `archived_funnels.steps` times out Postgres and can stall Supabase.
 */

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  try {
    const { allowed } = await canAccessProject(req, id);
    if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const { rows, error } = await loadSlimArchivedFunnels(id, 400);
    if (error) return NextResponse.json({ error }, { status: 500 });

    const landings = rows.flatMap((row) => {
      const raw = (Array.isArray(row.steps) ? row.steps : []) as Record<string, unknown>[];
      const steps = dedupeStepsByUrl(raw) as SlimArchiveStep[];
      if (!steps.length) {
        return [{
          id: row.id,
          name: row.name,
          url: '',
          page_type: 'landing',
          category: row.name || '',
          tags: [] as string[],
          screenshot: '',
          screenshot_desktop: '',
          screenshot_mobile: '',
          html_url: `/api/funnel-html?pageId=${encodeURIComponent(row.id)}&kind=cloned&variant=desktop`,
          editor_url: `/edit/${row.id}`,
          created_at: row.created_at,
        }];
      }
      const multi = steps.length > 1;
      return steps.map((step, i) => {
        const cd = step?.cloned_data || {};
        const keyId = step?.page_id || row.id;
        return {
          id: multi ? `${row.id}::${i}` : row.id,
          name: step?.name || row.name,
          url: cd.source_url || step.url_to_swipe || '',
          page_type: step?.page_type || 'landing',
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
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
