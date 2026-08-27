/**
 * TEMPORARY — re-link recovered archive rows to their projects by domain.
 * Token-guarded. REMOVE after use.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

const TOKEN = 'wsb-diag-8f3a1c6e2b';

// domain (suffix match on hostname) → project name (exact, as in projects.name)
const LINKS: Array<{ domain: string; project: string }> = [
  { domain: 'wellaray.com', project: 'Wellaray — Slim Coffee Booster' },
  { domain: 'jetterix.com', project: 'Jetterix DE' },
  { domain: 'concealedtrainingfirst.com', project: 'Concealed Training First' },
  { domain: 'tryneuroflush.com', project: 'NeuroFlush' },
  { domain: 'tryneurocleanse.com', project: 'Nuerocleanse' },
  { domain: 'nooro-switch-metabolic.replit.app', project: 'Metabolic Wave' },
];

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const { data: projects, error: pErr } = await supabaseAdmin
    .from('projects')
    .select('id, name');
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
  const projByName = new Map((projects || []).map((p) => [p.name, p.id]));

  const { data: rows, error: rErr } = await supabaseAdmin
    .from('archived_funnels')
    .select('id, name, steps, project_id')
    .is('project_id', null);
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });

  const linked: Record<string, number> = {};
  const errors: string[] = [];
  for (const row of rows || []) {
    const step = Array.isArray(row.steps) ? (row.steps[0] as Record<string, unknown>) : null;
    const url = String(step?.url_to_swipe || '');
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!host) continue;

    const match = LINKS.find((l) => host === l.domain || host.endsWith('.' + l.domain));
    if (!match) continue;
    const projectId = projByName.get(match.project);
    if (!projectId) { errors.push(`project not found: ${match.project}`); continue; }

    const { error: uErr } = await supabaseAdmin
      .from('archived_funnels')
      .update({ project_id: projectId })
      .eq('id', row.id);
    if (uErr) { errors.push(`${row.id}: ${uErr.message}`); continue; }
    linked[match.project] = (linked[match.project] || 0) + 1;
  }

  return NextResponse.json({ linked, errors });
}
