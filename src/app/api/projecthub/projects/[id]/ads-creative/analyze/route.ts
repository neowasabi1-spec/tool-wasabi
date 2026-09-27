import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { enqueueAdsIntelJob } from '@/lib/ads-intel/jobs';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST { adSource?: 'competitor', adRefId: string | number }
 * Enqueues analyze (runs inline locally when ADS_INTEL_INLINE / non-production).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const adSource = body.adSource === 'own' ? 'own' : 'competitor';
  const adRefId = String(body.adRefId ?? body.adId ?? '').trim();
  if (!adRefId) {
    return NextResponse.json({ error: 'adRefId is required' }, { status: 400 });
  }

  try {
    const { jobId, ranInline } = await enqueueAdsIntelJob({
      projectId,
      type: 'analyze_ad',
      payload: { adSource, adRefId },
    });

    // If inline, wait briefly so smoke tests get a ready analysis
    let analysis = null;
    if (ranInline) {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const { data: job } = await supabaseAdmin
          .from('ads_intel_jobs')
          .select('status, result, error')
          .eq('id', jobId)
          .maybeSingle();
        if (!job) break;
        if (job.status === 'completed' || job.status === 'failed') {
          const { data: row } = await supabaseAdmin
            .from('creative_analyses')
            .select('*')
            .eq('project_id', projectId)
            .eq('ad_source', adSource)
            .eq('ad_ref_id', adRefId)
            .maybeSingle();
          analysis = row;
          return NextResponse.json({
            jobId,
            ranInline,
            status: job.status,
            error: job.error || undefined,
            analysis,
            result: job.result,
          });
        }
      }
    }

    return NextResponse.json({ jobId, ranInline, status: 'pending', analysis });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = /ads_intel_jobs|creative_analyses/i.test(msg)
      ? ' Apply supabase-migration-ads-intel.sql on DEV Supabase.'
      : '';
    return NextResponse.json({ error: msg + hint }, { status: 500 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(req.url);
  const adRefId = url.searchParams.get('adRefId') || '';
  const adSource = url.searchParams.get('adSource') || 'competitor';

  let q = supabaseAdmin
    .from('creative_analyses')
    .select('*')
    .eq('project_id', projectId)
    .order('updated_at', { ascending: false })
    .limit(50);

  if (adRefId) q = q.eq('ad_ref_id', adRefId).eq('ad_source', adSource);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json(
      {
        error:
          error.message +
          (/creative_analyses/i.test(error.message)
            ? ' Apply supabase-migration-ads-intel.sql on DEV Supabase.'
            : ''),
      },
      { status: 500 },
    );
  }
  return NextResponse.json({ analyses: data || [] });
}
