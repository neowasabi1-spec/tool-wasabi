/**
 * TEMPORARY — diagnose recovered landings previews + trigger the screenshot
 * backfill sweep. Token-guarded. REMOVE after use.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const TOKEN = 'wsb-diag-8f3a1c6e2b';

interface Step {
  page_id?: string;
  page_type?: string;
  name?: string;
  cloned_data?: {
    source_url?: string;
    htmlUrl?: string;
    screenshotDesktopUrl?: string | null;
    screenshotMobileUrl?: string | null;
    shotError?: string;
  };
}

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const { data: rows, error } = await supabaseAdmin
    .from('archived_funnels')
    .select('id, name, project_id, steps, created_at')
    .not('project_id', 'is', null)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const report = [];
  for (const r of (rows || []) as Array<{ id: string; name: string; project_id: string; steps: Step[] }>) {
    const steps = Array.isArray(r.steps) ? r.steps : [];
    for (const s of steps) {
      const cd = s.cloned_data || {};
      const pid = s.page_id || r.id;
      const { data: ph } = await supabaseAdmin
        .from('page_html')
        .select('html')
        .eq('page_id', pid)
        .eq('kind', 'cloned')
        .eq('variant', 'desktop')
        .maybeSingle();
      report.push({
        rowId: r.id,
        name: s.name || r.name,
        projectId: r.project_id,
        pageId: pid,
        pageType: s.page_type,
        sourceUrl: cd.source_url || '',
        htmlUrl: cd.htmlUrl || '',
        htmlLen: typeof ph?.html === 'string' ? ph.html.length : 0,
        shotDesktop: Boolean(cd.screenshotDesktopUrl),
        shotMobile: Boolean(cd.screenshotMobileUrl),
        shotError: cd.shotError || '',
      });
    }
  }
  return NextResponse.json({ pages: report.length, report });
}

// POST ?action=shots[&projectId=...] → invoke the screenshot background
// function with the server-side secret (scope=all when no projectId).
export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const projectId = req.nextUrl.searchParams.get('projectId') || '';
  const secret = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
  const base = process.env.URL || `${req.nextUrl.protocol}//${req.nextUrl.host}`;

  const r = await fetch(`${base}/.netlify/functions/competitor-shots-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(projectId ? { projectId, secret } : { scope: 'all', secret }),
  });
  const text = await r.text();
  return NextResponse.json({ triggered: true, status: r.status, body: text.slice(0, 500) });
}
