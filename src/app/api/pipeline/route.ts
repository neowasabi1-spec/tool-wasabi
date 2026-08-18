import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { listAccessibleProjectIds } from '@/lib/auth/project-access';
import { buildInitialSteps, type PipelineInput } from '@/lib/pipeline/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pipeline  — Project Autopilot orchestrator (enqueue).
 *
 * Body: { product, competitorLink?, description?, language?, projectId? }
 *
 * Step 0: resolve the project — if `projectId` is given (and accessible) use
 * it; else match an existing accessible project by name; else create one.
 * Then create a pipeline_jobs row (all steps pending) and fire the Netlify
 * background function that runs the steps in order. Returns { jobId, projectId }.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const product = String(body.product || '').trim();
  const competitorLink = body.competitorLink ? String(body.competitorLink).trim() : '';
  const description = body.description ? String(body.description).trim() : '';
  const market = body.market ? String(body.market).trim() : '';
  const language = body.language ? String(body.language).trim() : '';
  const requestedProjectId = body.projectId ? String(body.projectId) : '';

  if (!product && !requestedProjectId) {
    return NextResponse.json(
      { error: 'Serve almeno il nome prodotto o un projectId.' },
      { status: 400 },
    );
  }

  const ctx = await getUserAccessContext(req);

  // ── Step 0: resolve project (match existing or create) ──
  let projectId = '';
  let created = false;

  if (requestedProjectId) {
    const ok = await canAccess(ctx, requestedProjectId);
    if (!ok) return NextResponse.json({ error: 'Progetto non accessibile.' }, { status: 403 });
    projectId = requestedProjectId;
  } else {
    const match = await findProjectByName(ctx, product);
    if (match) {
      projectId = match;
    } else {
      const insert: Record<string, unknown> = { name: product, status: 'active', description: '' };
      if (ctx.userId) insert.owner_user_id = ctx.userId;
      const { data, error } = await supabaseAdmin
        .from('projects')
        .insert(insert)
        .select('id')
        .single();
      if (error || !data) {
        return NextResponse.json(
          { error: `Impossibile creare il progetto: ${error?.message || 'unknown'}` },
          { status: 500 },
        );
      }
      projectId = data.id as string;
      created = true;
    }
  }

  const input: PipelineInput = {
    product: product || '',
    competitorLink: competitorLink || undefined,
    description: description || undefined,
    market: market || undefined,
    language: language || undefined,
  };

  // ── Create the job row ──
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('pipeline_jobs')
    .insert({
      project_id: projectId,
      owner_user_id: ctx.userId,
      status: 'pending',
      input,
      steps: buildInitialSteps(),
    })
    .select('id')
    .single();

  if (jobErr || !job) {
    return NextResponse.json(
      { error: `Impossibile creare il job: ${jobErr?.message || 'unknown'}` },
      { status: 500 },
    );
  }

  // ── Fire the background sequencer (fire-and-forget) ──
  await triggerPipelineBackground(req, String(job.id));

  return NextResponse.json({ jobId: job.id, projectId, created });
}

/**
 * GET /api/pipeline?projectId=...  — list jobs for a project (most recent first).
 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'projectId richiesto' }, { status: 400 });
  }
  const ctx = await getUserAccessContext(req);
  const ok = await canAccess(ctx, projectId);
  if (!ok) return NextResponse.json({ error: 'Progetto non accessibile.' }, { status: 403 });

  const { data, error } = await supabaseAdmin
    .from('pipeline_jobs')
    .select('id, status, input, steps, current_step, error, created_at, updated_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function canAccess(
  ctx: { userId: string | null; isMaster: boolean },
  projectId: string,
): Promise<boolean> {
  if (!ctx.userId || ctx.isMaster) return true; // legacy / master: allow
  const { ownedIds, sharedIds } = await listAccessibleProjectIds(ctx.userId);
  return new Set([...ownedIds, ...sharedIds]).has(projectId);
}

async function findProjectByName(
  ctx: { userId: string | null; isMaster: boolean },
  name: string,
): Promise<string | null> {
  if (!name) return null;
  let query = supabaseAdmin
    .from('projects')
    .select('id, name, owner_user_id')
    .ilike('name', name)
    .order('created_at', { ascending: false })
    .limit(1);

  if (ctx.userId && !ctx.isMaster) {
    const { ownedIds, sharedIds } = await listAccessibleProjectIds(ctx.userId);
    const ids = Array.from(new Set([...ownedIds, ...sharedIds]));
    if (ids.length === 0) return null;
    query = query.in('id', ids);
  }

  const { data } = await query;
  return data && data.length > 0 ? (data[0].id as string) : null;
}

/** Trigger the Netlify background function that runs the pipeline steps.
 *  Fire-and-forget: the function responds 202 and keeps running up to 15 min. */
async function triggerPipelineBackground(req: NextRequest, jobId: string): Promise<void> {
  const origin =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    req.nextUrl.origin;
  try {
    await fetch(`${origin.replace(/\/$/, '')}/.netlify/functions/pipeline-run-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
  } catch (e) {
    console.warn('[pipeline] background trigger failed:', (e as Error).message);
  }
}
