/**
 * TEMPORARY — screenshot backfill helper for recovered archive pages.
 *
 * Chromium can't render these heavy pages inside a Netlify function (OOM), so
 * the RENDERING happens on the operator's machine; this route only does what
 * needs the service-role key:
 *
 *   GET  ?token&action=list          → pending items [{rowId, stepIdx, pageId}]
 *   GET  ?token&action=html&pageId=  → the saved HTML mirror for one page
 *   POST ?token&action=shot          → { pageId, variant, dataUrl } → upload JPEG, return url
 *   POST ?token&action=patch         → { rowId, stepIdx, desktopUrl, mobileUrl, failed? } → update row
 *
 * Token-guarded. REMOVE after use.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const TOKEN = 'wsb-diag-8f3a1c6e2b';

interface StepData {
  page_id?: string;
  cloned_data?: {
    screenshotDesktopUrl?: string | null;
    screenshotMobileUrl?: string | null;
    shotBackfillFailed?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface Row {
  id: string;
  steps: StepData[];
  project_id: string | null;
}

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const action = req.nextUrl.searchParams.get('action') || 'list';

  if (action === 'html') {
    const pageId = req.nextUrl.searchParams.get('pageId') || '';
    const { data } = await supabaseAdmin
      .from('page_html')
      .select('html')
      .eq('page_id', pageId)
      .eq('kind', 'cloned')
      .eq('variant', 'desktop')
      .maybeSingle();
    return new NextResponse((data?.html as string) || '', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // action=list
  const { data, error } = await supabaseAdmin
    .from('archived_funnels')
    .select('id, steps, project_id')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items: Array<{ rowId: string; stepIdx: number; pageId: string }> = [];
  const rows = (data || []) as Row[];
  const ordered = [...rows.filter((r) => r.project_id), ...rows.filter((r) => !r.project_id)];
  for (const row of ordered) {
    if (!Array.isArray(row.steps)) continue;
    row.steps.forEach((step, i) => {
      const cd = step?.cloned_data;
      if (!cd || cd.screenshotDesktopUrl || cd.shotBackfillFailed) return;
      items.push({ rowId: row.id, stepIdx: i, pageId: step.page_id || row.id });
    });
  }
  return NextResponse.json({ version: 3, items });
}

function decodeDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  try {
    return Buffer.from(m[1], 'base64');
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const action = req.nextUrl.searchParams.get('action') || '';
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  if (action === 'shot') {
    const pageId = String(body.pageId || '');
    const variant = body.variant === 'mobile' ? 'mobile' : 'desktop';
    const buffer = decodeDataUrl(String(body.dataUrl || ''));
    if (!pageId || !buffer || buffer.length === 0) {
      return NextResponse.json({ error: 'missing pageId/dataUrl' }, { status: 400 });
    }
    const path = `extension-captures/${pageId}/${variant}.jpg`;
    const { error } = await supabaseAdmin.storage
      .from('media')
      .upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const { data } = supabaseAdmin.storage.from('media').getPublicUrl(path);
    return NextResponse.json({ url: data.publicUrl });
  }

  if (action === 'patch') {
    const rowId = String(body.rowId || '');
    const stepIdx = Number(body.stepIdx);
    const { data, error } = await supabaseAdmin
      .from('archived_funnels')
      .select('id, steps')
      .eq('id', rowId)
      .maybeSingle();
    if (error || !data) return NextResponse.json({ error: error?.message || 'row not found' }, { status: 404 });
    const steps = (data.steps || []) as StepData[];
    const step = steps[stepIdx];
    if (!step?.cloned_data) return NextResponse.json({ error: 'step not found' }, { status: 404 });
    if (body.failed) {
      step.cloned_data.shotBackfillFailed = true;
    } else {
      step.cloned_data.screenshotDesktopUrl = String(body.desktopUrl || '');
      if (body.mobileUrl) step.cloned_data.screenshotMobileUrl = String(body.mobileUrl);
    }
    const { error: uErr } = await supabaseAdmin
      .from('archived_funnels')
      .update({ steps })
      .eq('id', rowId);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
