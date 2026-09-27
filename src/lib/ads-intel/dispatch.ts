/**
 * Unified dispatcher: Jev full pipeline + Wasabi Meta sync helpers.
 */
import { runJob as runJevJob } from './jev/pipeline/dispatch';
import { db } from './jev/db';
import { syncOwnAdsForProject } from './meta/sync';
import { finishJob, loadJob, markProcessing, setJobProgress } from './jobs';
import { openaiGenerateImageBytes } from '@/lib/openai-image';
import { putMedia } from './jev/storage';

async function finishJevJob(jobId: string, ok: boolean, result?: unknown, error?: string) {
  if (ok) {
    await db()
      .from('jev_jobs')
      .update({
        status: 'done',
        result: result ?? {},
        finished_at: new Date().toISOString(),
        error: null,
      })
      .eq('id', jobId);
  } else {
    await db()
      .from('jev_jobs')
      .update({
        status: 'error',
        error: (error || 'error').slice(0, 2000),
        finished_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}

/** Run a jev_jobs row by id (UUID). */
export async function runJevJobById(jobId: string): Promise<void> {
  const { data: job } = await db().from('jev_jobs').select('*').eq('id', jobId).maybeSingle();
  if (!job) throw new Error(`jev job ${jobId} not found`);

  await db()
    .from('jev_jobs')
    .update({ status: 'running', started_at: new Date().toISOString(), attempts: (job.attempts || 0) + 1 })
    .eq('id', jobId)
    .in('status', ['queued', 'running']);

  try {
    const result = await runJevJob(String(job.type), job.payload || {}, jobId);
    await finishJevJob(jobId, true, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'Annullato' || /cancel/i.test(msg)) {
      await db()
        .from('jev_jobs')
        .update({ status: 'cancelled', finished_at: new Date().toISOString(), progress: 'cancelled' })
        .eq('id', jobId);
      return;
    }
    await finishJevJob(jobId, false, undefined, msg);
  }
}

/** Legacy ads_intel_jobs runner (numeric ids) — bridges to Jev where possible. */
export async function runAdsIntelJob(jobId: number): Promise<void> {
  const claimed = await markProcessing(jobId);
  const job = claimed || (await loadJob(jobId));
  if (!job) {
    await finishJob(jobId, { ok: false, error: 'Job not found' });
    return;
  }

  const type = String(job.type || '');
  const projectId = String(job.project_id || '');
  const payload = (job.payload || {}) as Record<string, unknown>;

  try {
    if (type === 'ping') {
      await finishJob(jobId, { ok: true, result: { pong: true } });
      return;
    }

    if (type === 'sync_meta_ads') {
      await setJobProgress(jobId, 'Syncing Meta ads…');
      const result = await syncOwnAdsForProject({
        projectId,
        userId: payload.userId ? String(payload.userId) : null,
        adAccountId: payload.adAccountId ? String(payload.adAccountId) : undefined,
      });
      await finishJob(jobId, { ok: true, result });
      return;
    }

    // Map analyze → ingest + extract + analyze via jev_jobs
    if (type === 'analyze_ad' || type === 'extract_ad') {
      const adSource = String(payload.adSource || 'competitor');
      const adRefId = String(payload.adRefId || '');
      await setJobProgress(jobId, 'Ingesting into Jev creatives…');

      const { enqueue } = await import('./jev/jobs');
      const { ingestCompetitorAd, ingestOwnAd } = await import('./jev/pipeline/ingest');
      const { extractCreative } = await import('./jev/pipeline/extract');
      const { analyzeCreative } = await import('./jev/pipeline/analyze');

      const ingested =
        adSource === 'own'
          ? await ingestOwnAd(projectId, adRefId)
          : await ingestCompetitorAd(projectId, adRefId);

      await setJobProgress(jobId, 'Extracting…');
      await extractCreative(ingested.creativeId);
      await setJobProgress(jobId, 'Analyzing…');
      await analyzeCreative(ingested.creativeId);

      await finishJob(jobId, { ok: true, result: ingested });
      return;
    }

    if (type === 'generate_concepts') {
      const { enqueue } = await import('./jev/jobs');
      const { generateConcepts } = await import('./jev/pipeline/concepts');
      const { createBatch } = await import('./jev/batches');
      const { data: product } = await db()
        .from('jev_products')
        .select('id')
        .eq('project_id', projectId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!product) throw new Error('No jev product — analyze an ad first (creates default product)');

      let creativeIds = (payload.creativeIds as string[]) || [];
      if (!creativeIds.length) {
        const { data: creatives } = await db()
          .from('jev_creatives')
          .select('id')
          .eq('project_id', projectId)
          .eq('extraction_status', 'done')
          .order('created_at', { ascending: false })
          .limit(8);
        creativeIds = (creatives || []).map((c: any) => c.id);
      }
      if (!creativeIds.length) throw new Error('No extracted creatives — Analyze ads first');

      const sources = creativeIds.map((id) => ({ creativeId: id }));
      const kind = (payload.kind as 'text' | 'image' | 'video') || 'image';
      const count = Number(payload.count || 3);
      const batchId = await createBatch(
        product.id,
        'manual',
        `Concepts · ${kind}`,
        { kind, count, sources },
      );
      await setJobProgress(jobId, 'Generating concepts (Jev)…');
      const result = await generateConcepts(
        product.id,
        {
          kind,
          count,
          sources,
          varyAxis: 'all',
          mutations: ['none', 'change_avatar', 'invert_angle'],
          combine: Boolean(payload.combine),
          batchId,
        } as any,
      );
      await finishJob(jobId, { ok: true, result });
      return;
    }

    if (type === 'create_output') {
      const conceptId = String(payload.conceptId || '');
      if (!conceptId) throw new Error('conceptId required');
      const { enqueue } = await import('./jev/jobs');
      const jev = await enqueue('create_output', { conceptId, language: payload.language || 'en' }, projectId);
      await runJevJobById(jev.id);

      // Native asset generation for image outputs awaiting upload
      const { data: outs } = await db()
        .from('jev_outputs')
        .select('*')
        .eq('concept_id', conceptId)
        .order('created_at', { ascending: false })
        .limit(1);
      const out = outs?.[0];
      if (out && out.kind === 'image' && !['1', 'true', 'yes'].includes((process.env.ADS_INTEL_SKIP_ASSETS || '').toLowerCase())) {
        const spec = out.spec || {};
        const prompt = String(spec.prompt || spec.image_prompt || spec.chatgpt_prompt || JSON.stringify(spec)).slice(0, 4000);
        if (prompt) {
          await setJobProgress(jobId, 'Generating image asset…');
          const bytes = await openaiGenerateImageBytes({ prompt, size: '1024x1024', timeoutMs: 180_000 });
          if (bytes) {
            const path = `${projectId}/jev/outputs/${out.code || out.id}.png`;
            await putMedia(path, bytes.buf, bytes.mime);
            await db()
              .from('jev_outputs')
              .update({ result_path: path, status: 'awaiting_upload' })
              .eq('id', out.id);
            const { enqueue: enq } = await import('./jev/jobs');
            const up = await enq('analyze_upload', { outputId: out.id }, projectId);
            await runJevJobById(up.id);
          }
        }
      }

      const { data: done } = await db().from('jev_jobs').select('status,result,error').eq('id', jev.id).single();
      if (done?.status === 'done') await finishJob(jobId, { ok: true, result: { jev: done.result, output: out } });
      else await finishJob(jobId, { ok: false, error: String(done?.error || 'output failed') });
      return;
    }

    // Direct passthrough: enqueue as jev job type
    const { enqueue } = await import('./jev/jobs');
    const jev = await enqueue(type as any, { ...payload, projectId }, projectId);
    await runJevJobById(jev.id);
    const { data: done } = await db().from('jev_jobs').select('status,result,error').eq('id', jev.id).single();
    if (done?.status === 'done') await finishJob(jobId, { ok: true, result: done.result });
    else await finishJob(jobId, { ok: false, error: String(done?.error || 'failed') });
  } catch (e) {
    await finishJob(jobId, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export { runJevJob };
