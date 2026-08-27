/**
 * TEMPORARY diagnostic route — inspect archived_funnels project links.
 * Guarded by a one-off token. REMOVE after the investigation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, hasServiceRoleKey } from '@/lib/supabase-admin';
import { inferPageType } from '@/lib/server/page-type-classifier';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TOKEN = 'wsb-diag-8f3a1c6e2b';
export const maxDuration = 120;

// Fallback owner for page_html mirrors saved without owner_user_id
// (e.g. Chimera competitor-scrape) — the workspace owner.
const DEFAULT_OWNER = 'ef07e744-61e6-47ef-848d-90a11898e8d3';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return m[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim().slice(0, 150);
}

function extractSourceUrl(html: string): string {
  const og = html.match(/<meta[^>]+property\s*=\s*["']og:url["'][^>]+content\s*=\s*["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:url["']/i);
  if (og?.[1]?.startsWith('http')) return og[1];
  const canonical = html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]+href\s*=\s*["']([^"']+)["']/i)
    || html.match(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]+rel\s*=\s*["']canonical["']/i);
  if (canonical?.[1]?.startsWith('http')) return canonical[1];
  const baseTag = html.match(/<base[^>]+href\s*=\s*["'](https?:\/\/[^"']+)["']/i);
  if (baseTag?.[1]) return baseTag[1];
  return '';
}

/**
 * POST — rebuild archived_funnels rows from the surviving page_html mirrors
 * (the archive table was wiped; HTML + screenshots survived). Idempotent:
 * pages whose id already exists in archived_funnels are skipped, so it can
 * run in batches until `remaining` is 0.
 *
 * ?action=rebuild&limit=25   → process next N unrebuilt pages
 * ?action=group              → rename same-domain sessions to "<domain> — Step N"
 *                              so the Templates UI folds them into folders
 */
export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const action = req.nextUrl.searchParams.get('action') || 'rebuild';
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 25, 60);

  if (action === 'group') return groupWalkSessions();

  // 1) candidate pages = page_html cloned/desktop mirrors, oldest first
  const { data: pages, error: listErr } = await supabaseAdmin
    .from('page_html')
    .select('page_id, owner_user_id, updated_at')
    .eq('kind', 'cloned')
    .eq('variant', 'desktop')
    .order('updated_at', { ascending: true });
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });

  // 2) exclusions: Clone/Swipe pages (funnel_pages) + already-rebuilt rows
  const [{ data: fp }, { data: existing }] = await Promise.all([
    supabaseAdmin.from('funnel_pages').select('id'),
    supabaseAdmin.from('archived_funnels').select('id'),
  ]);
  const skipIds = new Set([
    ...((fp || []) as { id: string }[]).map((r) => r.id),
    ...((existing || []) as { id: string }[]).map((r) => r.id),
  ]);

  const todo = ((pages || []) as { page_id: string; owner_user_id: string | null; updated_at: string }[])
    .filter((p) => UUID_RE.test(p.page_id) && !skipIds.has(p.page_id));

  const batch = todo.slice(0, limit);
  let inserted = 0;
  const errors: string[] = [];

  for (const p of batch) {
    try {
      const { data: rec } = await supabaseAdmin
        .from('page_html')
        .select('html')
        .eq('page_id', p.page_id)
        .eq('kind', 'cloned')
        .eq('variant', 'desktop')
        .maybeSingle();
      const html = typeof rec?.html === 'string' ? rec.html : '';
      if (html.length < 100) { errors.push(`${p.page_id}: empty html`); continue; }

      const title = extractTitle(html);
      const url = extractSourceUrl(html);
      let domain = '';
      try { domain = url ? new URL(url).hostname : ''; } catch { /* keep '' */ }
      const name = title || domain || 'Recovered page';
      const pageType = inferPageType({ url, title, name, html: html.slice(0, 400_000) });

      // screenshots saved by the extension live at extension-captures/<pageId>/
      let shotDesktop: string | null = null;
      let shotMobile: string | null = null;
      try {
        const { data: files } = await supabaseAdmin.storage.from('media').list(`extension-captures/${p.page_id}`);
        for (const f of files || []) {
          const pub = supabaseAdmin.storage.from('media').getPublicUrl(`extension-captures/${p.page_id}/${f.name}`).data.publicUrl;
          if (/^desktop\./i.test(f.name)) shotDesktop = pub;
          if (/^mobile\./i.test(f.name)) shotMobile = pub;
        }
      } catch { /* screenshots optional */ }

      const step = {
        step_index: 1,
        name,
        page_type: pageType,
        category: '',
        template_name: '',
        product_name: '',
        url_to_swipe: url,
        prompt: '',
        feedback: '',
        swipe_status: 'completed',
        swipe_result: '',
        swiped_data: null,
        cloned_data: {
          title,
          source_url: url,
          method_used: 'rebuild-from-page-html',
          cloned_at: p.updated_at,
          category: '',
          tags: [],
          screenshotDesktopUrl: shotDesktop,
          screenshotMobileUrl: shotMobile,
          htmlUrl: `/api/funnel-html?pageId=${encodeURIComponent(p.page_id)}&kind=cloned&variant=desktop`,
        },
        page_id: p.page_id,
      };

      const { error: insErr } = await supabaseAdmin.from('archived_funnels').insert({
        id: p.page_id, // single-page saves used the row id as page_id → /edit/<id> links keep working
        name,
        total_steps: 1,
        steps: [step],
        owner_user_id: p.owner_user_id || DEFAULT_OWNER,
        created_at: p.updated_at,
      });
      if (insErr) { errors.push(`${p.page_id}: ${insErr.message}`); continue; }
      inserted++;
    } catch (e) {
      errors.push(`${p.page_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return NextResponse.json({
    action,
    candidates: todo.length,
    processed: batch.length,
    inserted,
    remaining: todo.length - batch.length,
    errors,
  });
}

/**
 * Group recovered pages into walk folders: same domain + saves within 45 min
 * of each other = one funnel walk. Rows get renamed "<domain> — Step N" (in
 * chronological order), which the Templates UI already folds into one folder.
 * Only touches rows created by the rebuild (method_used marker) that are
 * still single-step and not yet renamed.
 */
async function groupWalkSessions() {
  const { data: rows, error } = await supabaseAdmin
    .from('archived_funnels')
    .select('id, name, steps, created_at')
    .order('created_at', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = { id: string; name: string; steps: Array<Record<string, unknown>>; created_at: string };
  const rebuilt = ((rows || []) as Row[]).filter((r) => {
    const s = Array.isArray(r.steps) ? r.steps[0] : null;
    const cd = (s?.cloned_data || {}) as Record<string, unknown>;
    return cd.method_used === 'rebuild-from-page-html' && !/—\s*Step\s+\d+$/i.test(r.name);
  });

  const byDomain = new Map<string, Row[]>();
  for (const r of rebuilt) {
    const s = r.steps[0] as { url_to_swipe?: string };
    let domain = '';
    try { domain = s?.url_to_swipe ? new URL(s.url_to_swipe).hostname : ''; } catch { /* skip */ }
    if (!domain) continue;
    byDomain.set(domain, [...(byDomain.get(domain) || []), r]);
  }

  let renamed = 0;
  const WINDOW_MS = 45 * 60 * 1000;
  for (const [domain, group] of byDomain) {
    // split into time sessions
    const sessions: Row[][] = [];
    let cur: Row[] = [];
    let lastTs = 0;
    for (const r of group) {
      const ts = new Date(r.created_at).getTime();
      if (cur.length && ts - lastTs > WINDOW_MS) { sessions.push(cur); cur = []; }
      cur.push(r);
      lastTs = ts;
    }
    if (cur.length) sessions.push(cur);

    for (const session of sessions) {
      if (session.length < 2) continue; // lone page → keep its title as name
      for (let i = 0; i < session.length; i++) {
        const r = session[i];
        const newName = `${domain} — Step ${i + 1}`;
        const steps = r.steps.map((s0) => ({ ...s0, name: newName }));
        const { error: upErr } = await supabaseAdmin
          .from('archived_funnels')
          .update({ name: newName, steps })
          .eq('id', r.id);
        if (!upErr) renamed++;
      }
    }
  }

  return NextResponse.json({ action: 'group', rebuiltRows: rebuilt.length, renamed });
}

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const [{ count: total }, { count: linked }, { data: recent }, { data: linkedRows }] =
    await Promise.all([
      supabaseAdmin.from('archived_funnels').select('id', { count: 'exact', head: true }),
      supabaseAdmin
        .from('archived_funnels')
        .select('id', { count: 'exact', head: true })
        .not('project_id', 'is', null),
      supabaseAdmin
        .from('archived_funnels')
        .select('id, name, project_id, owner_user_id, total_steps, created_at, section')
        .order('created_at', { ascending: false })
        .limit(30),
      supabaseAdmin
        .from('archived_funnels')
        .select('id, name, project_id, created_at')
        .not('project_id', 'is', null)
        .limit(30),
    ]);

  const counts: Record<string, number | string> = {};
  for (const t of ['archived_funnels', 'archive_categories', 'projects', 'funnel_pages', 'page_html']) {
    const { count, error } = await supabaseAdmin.from(t).select('*', { count: 'exact', head: true });
    counts[t] = error ? `ERR ${error.message}` : (count ?? -1);
  }

  // Decisive probe: a REAL service-role key bypasses RLS, so an insert +
  // read-back must succeed. If the insert is rejected by RLS, the configured
  // "service" key is actually anon-level and the data is merely invisible.
  const probe: Record<string, unknown> = {};
  const { data: ins, error: insErr } = await supabaseAdmin
    .from('archived_funnels')
    .insert({ name: '__wsb_diag_probe__', total_steps: 0, steps: [] })
    .select('id')
    .single();
  probe.insertError = insErr ? insErr.message : null;
  if (ins?.id) {
    const { data: back, error: readErr } = await supabaseAdmin
      .from('archived_funnels')
      .select('id, name')
      .eq('id', ins.id)
      .maybeSingle();
    probe.readBack = back ? 'ok' : `MISSING${readErr ? ' err=' + readErr.message : ''}`;
    const { error: delErr } = await supabaseAdmin.from('archived_funnels').delete().eq('id', ins.id);
    probe.cleanup = delErr ? `ERR ${delErr.message}` : 'deleted';
  }

  return NextResponse.json({
    hasServiceRoleKey: hasServiceRoleKey(),
    probe,
    counts,
    total,
    linked,
    linkedRows,
    recent,
  });
}
