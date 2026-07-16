import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Saves edited HTML for a page captured by the extension. Writes the canonical
 * copy to `page_html` AND keeps the archive preview in sync by patching the
 * matching `archived_funnels` step's inline `cloned_data.html`.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const pageId = typeof body?.pageId === 'string' ? body.pageId : '';
  const html = typeof body?.html === 'string' ? body.html : '';

  if (!pageId || !html) {
    return NextResponse.json({ error: 'pageId and html are required' }, { status: 400 });
  }

  const userId = await getCurrentUserId(req);
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 1) Canonical copy in page_html.
  const { error: htmlErr } = await supabaseAdmin.from('page_html').upsert(
    {
      page_id: pageId,
      kind: 'cloned',
      variant: 'desktop',
      html,
      owner_user_id: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'page_id,kind,variant' },
  );
  if (htmlErr) {
    return NextResponse.json({ error: htmlErr.message }, { status: 500 });
  }

  // 2) Keep the archive step in sync (best-effort).
  try {
    const { data: row } = await supabaseAdmin
      .from('archived_funnels')
      .select('id, steps, owner_user_id')
      .eq('id', pageId)
      .maybeSingle();
    if (row && (!row.owner_user_id || row.owner_user_id === userId)) {
      const steps = Array.isArray(row.steps) ? [...(row.steps as Record<string, unknown>[])] : [];
      if (steps[0]) {
        const cd = (steps[0].cloned_data as Record<string, unknown>) || {};
        steps[0] = { ...steps[0], cloned_data: { ...cd, html } };
        await supabaseAdmin.from('archived_funnels').update({ steps }).eq('id', pageId);
      }
    }
  } catch (e) {
    console.warn('[extension/save-html] archive sync skipped:', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({ success: true });
}
