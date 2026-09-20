/**
 * List funnel_pages without ever reading cloned_data / swiped_data JSONB.
 * Those columns hold 1–5 MB HTML each; selecting them (or `jsonb - 'html'`)
 * detoasts the whole blob, which is what timed out the SQL editor and
 * 57014'd Postgres. HTML is fetched later from `page_html` via htmlUrl.
 */

import { supabaseAdmin } from './supabase-admin';

const LIST_COLS = [
  'id, name, page_type, template_id, product_id, project_id, url_to_swipe, prompt, swipe_status, swipe_result, feedback, analysis_status, analysis_result, owner_user_id, created_at, updated_at',
  'id, name, page_type, template_id, product_id, project_id, url_to_swipe, prompt, swipe_status, swipe_result, feedback, analysis_status, analysis_result, created_at, updated_at',
  'id, name, page_type, template_id, product_id, url_to_swipe, prompt, swipe_status, swipe_result, created_at, updated_at',
];

function stubHtmlPointers(row: Record<string, unknown>): Record<string, unknown> {
  const id = String(row.id || '');
  const pointer = (kind: string) =>
    id ? `/api/funnel-html?pageId=${encodeURIComponent(id)}&kind=${kind}&variant=desktop` : undefined;
  // Pointer only — do NOT set htmlSkipped. That flag means "JSONB was
  // stripped after a real persist". Using it on every list stub made the
  // Clone/Swipe eye toast "HTML was > 50KB…" for pages that only had a
  // clone (the stub swiped_data looked like a skipped swipe).
  row.cloned_data = { htmlUrl: pointer('cloned') };
  row.swiped_data = { htmlUrl: pointer('swiped') };
  row.extracted_data = { htmlUrl: pointer('extracted') };
  return row;
}

export async function loadSlimFunnelPages(): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  let lastError: string | null = null;
  for (const cols of LIST_COLS) {
    const { data, error } = await supabaseAdmin
      .from('funnel_pages')
      .select(cols)
      .order('created_at', { ascending: true });
    if (!error) {
      return {
        rows: (data || []).map((r) => stubHtmlPointers({ ...(r as Record<string, unknown>) })),
        error: null,
      };
    }
    lastError = error.message;
    if (!/does not exist|42703|schema cache/i.test(error.message || '')) {
      return { rows: [], error: lastError };
    }
  }
  return { rows: [], error: lastError };
}
