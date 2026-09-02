/**
 * GET /api/valchiria/funnels
 *
 * Templates is a SHARED team library: every authenticated user sees the
 * same `archived_funnels` rows (project_id IS NULL). Competitor landings
 * tied to a project stay out of this list.
 *
 * Protocollo Valchiria stays personal: `isInMyValchiria` is still
 * per-caller (own `show_in_valchiria` or a row in valchiria_user_picks).
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { dedupeStepsByUrl } from '@/lib/archive-placement';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

interface ValchiriaFunnelRow {
  id: string;
  name: string;
  total_steps: number;
  steps: unknown;
  section: string | null;
  created_at: string;
  owner_user_id: string | null;
  show_in_valchiria: boolean;
  share_with_users: boolean;
  /** TRUE when the row is part of the master's library and the caller
   *  is NOT the master. UI uses this to hide edit/delete + render the
   *  Shared badge. */
  isShared: boolean;
  /** Resolved per-caller: TRUE when the row should appear in the
   *  caller's own /protocollo-valchiria.
   *   - Own rows: equal to show_in_valchiria.
   *   - Shared rows (for non-master callers): TRUE only if the caller
   *     has explicitly picked it via the /api/valchiria/funnels/[id]
   *     PATCH endpoint. */
  isInMyValchiria: boolean;
}

const SELECT_COLS =
  'id, name, total_steps, steps, section, created_at, owner_user_id, show_in_valchiria, share_with_users';

/**
 * Strip the heavy inline HTML blobs from every step before shipping the list
 * to the browser. Extension saves historically stored the ENTIRE rendered
 * page (1-5 MB each) inside `steps[].cloned_data.html`; with dozens of saved
 * landings/funnel walks the list response ballooned to tens/hundreds of MB,
 * froze the tab on JSON.parse ("il tool collassa") and the stalled boot was
 * then misread as a dead session → forced logout.
 *
 * The HTML is always mirrored in the `page_html` table, so we replace the
 * blob with a small `htmlUrl` pointer (`/api/funnel-html?...`) the UI fetches
 * on demand (preview modal / thumbnails). Screenshots and metadata pass
 * through untouched.
 */
function uniqueSteps(steps: unknown): { steps: Record<string, unknown>[]; changed: boolean } {
  if (!Array.isArray(steps)) return { steps: [], changed: false };
  const unique = dedupeStepsByUrl(steps as Record<string, unknown>[]).map((s, i) => ({
    ...s,
    step_index: i + 1,
  }));
  return { steps: unique, changed: unique.length !== steps.length };
}

function slimSteps(rowId: string, steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps;
  return steps.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const step = { ...(raw as Record<string, unknown>) };
    for (const key of ['cloned_data', 'swiped_data', 'extracted_data'] as const) {
      const blob = step[key];
      if (!blob || typeof blob !== 'object' || Array.isArray(blob)) continue;
      const b = { ...(blob as Record<string, unknown>) };
      const hadHtml = typeof b.html === 'string' && (b.html as string).length > 0;
      delete b.html;
      delete b.mobileHtml;
      if (hadHtml && typeof b.htmlUrl !== 'string') {
        // Extension saves mirror the HTML into page_html keyed by the step's
        // page_id (funnel walks) or the row id (single-page saves).
        const pid = typeof step.page_id === 'string' && step.page_id ? (step.page_id as string) : rowId;
        b.htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(pid)}&kind=cloned&variant=desktop`;
      }
      step[key] = b;
    }
    return step;
  });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getUserAccessContext(req);

    const { data, error } = await supabaseAdmin
      .from('archived_funnels')
      .select(SELECT_COLS)
      .is('project_id', null)
      .order('created_at', { ascending: false });
    if (error) throw error;

    let pickedIds = new Set<string>();
    if (ctx.userId && !ctx.isMaster) {
      const picksRes = await supabaseAdmin
        .from('valchiria_user_picks')
        .select('funnel_id')
        .eq('user_id', ctx.userId);
      if (!picksRes.error) {
        pickedIds = new Set((picksRes.data || []).map((p: { funnel_id: string }) => p.funnel_id));
      }
    }

    const rows: ValchiriaFunnelRow[] = (data || []).map((r) => {
      const cleaned = uniqueSteps(r.steps);
      const mine = !r.owner_user_id || r.owner_user_id === ctx.userId || ctx.isMaster || !ctx.userId;
      return {
        ...r,
        total_steps: cleaned.steps.length || r.total_steps,
        steps: slimSteps(r.id, cleaned.steps.length ? cleaned.steps : r.steps),
        isShared: false,
        isInMyValchiria: mine ? !!r.show_in_valchiria : pickedIds.has(r.id),
      };
    });
    return NextResponse.json({ success: true, funnels: rows });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        funnels: [],
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
