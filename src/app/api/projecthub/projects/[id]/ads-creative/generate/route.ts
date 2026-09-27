import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { enqueueAdsIntelJob } from '@/lib/ads-intel/jobs';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

async function waitAdsIntelJob(jobId: number | string, attempts = 90) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const { data: job } = await supabaseAdmin
      .from('ads_intel_jobs')
      .select('status,result,error')
      .eq('id', jobId)
      .maybeSingle();
    if (job && (job.status === 'completed' || job.status === 'failed')) {
      return job;
    }
  }
  return null;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || 'concepts');

  try {
    if (action === 'concepts') {
      const { jobId, ranInline } = await enqueueAdsIntelJob({
        projectId,
        type: 'generate_concepts',
        payload: {
          analysisIds: body.analysisIds,
          count: body.count,
          creativeIds: body.creativeIds,
        },
      });
      if (ranInline) {
        const job = await waitAdsIntelJob(jobId, 90);
        if (job) {
          return NextResponse.json({
            ok: job.status === 'completed',
            jobId,
            result: job.result,
            error: job.error || undefined,
          });
        }
      }
      return NextResponse.json({ ok: true, jobId, ranInline });
    }

    if (action === 'output') {
      const conceptId = String(body.conceptId || '');
      if (!conceptId) return NextResponse.json({ error: 'conceptId required' }, { status: 400 });
      const { jobId, ranInline } = await enqueueAdsIntelJob({
        projectId,
        type: 'create_output',
        payload: { conceptId, language: body.language || 'en' },
      });
      if (ranInline) {
        const job = await waitAdsIntelJob(jobId, 120);
        if (job) {
          return NextResponse.json({
            ok: job.status === 'completed',
            jobId,
            output: job.result,
            error: job.error || undefined,
          });
        }
      }
      return NextResponse.json({ ok: true, jobId, ranInline });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** Prefer Jev tables; fall back to legacy creative_* if migrations not applied yet. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: products } = await supabaseAdmin
    .from('jev_products')
    .select('id')
    .eq('project_id', projectId);
  const pids = (products || []).map((p: { id: string }) => p.id);

  if (pids.length) {
    const [{ data: concepts }, { data: outputs }] = await Promise.all([
      supabaseAdmin
        .from('jev_concepts')
        .select('*')
        .in('product_id', pids)
        .order('created_at', { ascending: false })
        .limit(50),
      supabaseAdmin
        .from('jev_outputs')
        .select('*')
        .in('product_id', pids)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    return NextResponse.json({ concepts: concepts || [], outputs: outputs || [], source: 'jev' });
  }

  const [{ data: concepts }, { data: outputs }] = await Promise.all([
    supabaseAdmin
      .from('creative_concepts')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabaseAdmin
      .from('creative_outputs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  return NextResponse.json({ concepts: concepts || [], outputs: outputs || [], source: 'legacy' });
}
