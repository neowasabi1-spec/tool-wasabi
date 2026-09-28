import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { db } from '@/lib/ads-intel/jev/db';
import { enqueue } from '@/lib/ads-intel/jev/jobs';
import { runJevJobById } from '@/lib/ads-intel/dispatch';
import { adsIntelInline } from '@/lib/ads-intel/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/** GET — jev products, concepts, outputs, playbooks, jobs for project */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [products, creatives, concepts, outputs, playbooks, jobs] = await Promise.all([
    db().from('jev_products').select('*').eq('project_id', projectId).order('created_at'),
    db().from('jev_creatives').select('id, media_type, extraction_status, ranking, titles, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
    db().from('jev_concepts').select('*, jev_products!inner(project_id)').eq('jev_products.project_id', projectId).order('created_at', { ascending: false }).limit(50),
    db().from('jev_outputs').select('*, jev_products!inner(project_id)').eq('jev_products.project_id', projectId).order('created_at', { ascending: false }).limit(50),
    db().from('jev_playbooks').select('*, jev_products!inner(project_id)').eq('jev_products.project_id', projectId).order('version', { ascending: false }).limit(10),
    db().from('jev_jobs').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).limit(30),
  ]);

  // Template groups for "Template e stili" (best-effort; empty if migration not applied yet)
  let templateGroups: unknown[] = [];
  let templateStats: { images: number; withTemplate: number } = { images: 0, withTemplate: 0 };
  let styleFamilies: unknown[] = [];
  try {
    const productId = (products.data || [])[0]?.id as string | undefined;
    if (productId) {
      const { templateGroups: tg } = await import('@/lib/ads-intel/jev/pipeline/templates');
      templateGroups = await tg(productId);
      const [{ count: images }, { count: withTemplate }] = await Promise.all([
        db().from('jev_creatives').select('id', { count: 'exact', head: true }).eq('product_id', productId).in('media_type', ['image', 'carousel']),
        db().from('jev_templates').select('id', { count: 'exact', head: true }).eq('product_id', productId),
      ]);
      templateStats = { images: images ?? 0, withTemplate: withTemplate ?? 0 };
      // Attach anchor thumbs + specs for UI
      const ids = (templateGroups as { anchor: { templateId: string } }[]).slice(0, 20).map((g) => g.anchor.templateId);
      if (ids.length) {
        const { data: specs } = await db().from('jev_templates').select('id, spec, label').in('id', ids);
        const specMap = new Map((specs || []).map((t: any) => [t.id, t]));
        templateGroups = (templateGroups as any[]).map((g) => ({
          ...g,
          spec: specMap.get(g.anchor.templateId)?.spec ?? null,
        }));
      }
      try {
        const { imageFamilies } = await import('@/lib/ads-intel/jev/pipeline/families');
        styleFamilies = await imageFamilies(productId);
      } catch (fe) {
        console.warn('[jev] style families:', fe instanceof Error ? fe.message : fe);
      }
    }
  } catch (e) {
    console.warn('[jev] templates list:', e instanceof Error ? e.message : e);
  }

  // Fallback simpler queries if join fails
  const safe = async (res: any, fallback: () => Promise<any>) => {
    if (res.error) return fallback();
    return res.data || [];
  };

  return NextResponse.json({
    products: products.data || [],
    creatives: creatives.data || [],
    concepts: await safe(concepts, async () => {
      const pids = (products.data || []).map((p: any) => p.id);
      if (!pids.length) return [];
      const { data } = await db().from('jev_concepts').select('*').in('product_id', pids).order('created_at', { ascending: false }).limit(50);
      return data || [];
    }),
    outputs: await safe(outputs, async () => {
      const pids = (products.data || []).map((p: any) => p.id);
      if (!pids.length) return [];
      const { data } = await db().from('jev_outputs').select('*').in('product_id', pids).order('created_at', { ascending: false }).limit(50);
      return data || [];
    }),
    playbooks: await safe(playbooks, async () => {
      const pids = (products.data || []).map((p: any) => p.id);
      if (!pids.length) return [];
      const { data } = await db().from('jev_playbooks').select('*').in('product_id', pids).order('version', { ascending: false }).limit(10);
      return data || [];
    }),
    jobs: jobs.data || [],
    templateGroups,
    templateStats,
    styleFamilies,
    errors: {
      products: products.error?.message,
      creatives: creatives.error?.message,
      concepts: concepts.error?.message,
      outputs: outputs.error?.message,
    },
  });
}

/** POST — enqueue any Jev job type { type, payload } */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const type = String(body.type || '');
  if (!type) return NextResponse.json({ error: 'type required' }, { status: 400 });

  try {
    const payload = { ...(body.payload || {}), projectId };
    // Ensure productId for product-scoped jobs
    if (!payload.productId && ['build_corpus', 'build_playbook', 'analyze_product', 'generate_concepts', 'auto_prompts', 'build_families', 'recalibrate_weights', 'sync_marketing', 'fill_product_sheet', 'build_templates', 'template_creatives', 'family_generate'].includes(type)) {
      const { data: product } = await db().from('jev_products').select('id').eq('project_id', projectId).order('created_at').limit(1).maybeSingle();
      if (!product) return NextResponse.json({ error: 'No product — analyze an ad first' }, { status: 400 });
      payload.productId = product.id;
    }
    // Normalize template_creatives form opts onto payload.opts
    if (type === 'template_creatives' && !payload.opts) {
      payload.opts = {
        templates: Number(body.templates ?? payload.templates ?? 4),
        perTemplate: Number(body.perTemplate ?? payload.perTemplate ?? 3),
        language: String(body.language ?? payload.language ?? 'it'),
        groupKey: body.groupKey ?? payload.groupKey ?? undefined,
        images: body.images !== false && payload.images !== false,
      };
    }

    const row = await enqueue(type as any, payload, projectId);
    // enqueue already kicked the Netlify background worker (or inline in dev).

    if (body.wait || adsIntelInline()) {
      // Prefer polling the worker over re-running in the web request (long AI jobs).
      // Fallback: if still queued after a few seconds, run in-process.
      let last: Record<string, unknown> | null = null;
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { data } = await db()
          .from('jev_jobs')
          .select('status,result,error,progress')
          .eq('id', row.id)
          .single();
        last = data as Record<string, unknown> | null;
        if (data && ['done', 'error', 'cancelled'].includes(String(data.status))) {
          return NextResponse.json({ jobId: row.id, ...data });
        }
        // Worker didn't pick up — run here once, then keep polling.
        if (i === 4 && data && data.status === 'queued') {
          try {
            await runJevJobById(row.id);
          } catch (e) {
            console.warn('[jev] fallback runJevJobById:', e instanceof Error ? e.message : e);
          }
        }
      }
      return NextResponse.json({ jobId: row.id, ...(last || { status: 'queued' }) });
    }

    return NextResponse.json({ jobId: row.id, status: 'queued', worker: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
