import { db, must } from './db';

export type JobType =
  | 'refresh_source' | 'refresh_product' | 'refresh_project'
  | 'extract_creative' | 'analyze_creative' | 'analyze_product'
  | 'build_corpus' | 'build_playbook'
  | 'generate_concepts' | 'create_output' | 'analyze_upload'
  | 'sync_marketing' | 'fill_product_sheet' | 'reassign_product' | 'auto_prompts' | 'refine_output' | 'build_families' | 'family_generate' | 'hook_variants' | 'next_from_image'
  | 'build_templates' | 'template_creatives' | 'template_next'
  | 'ingest_from_competitor_ad' | 'ingest_from_own_ad' | 'record_outcome' | 'recalibrate_weights' | 'upsert_product';

export function jevInline(): boolean {
  const v = (process.env.ADS_INTEL_INLINE || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return process.env.NODE_ENV !== 'production';
}

function siteOrigin(): string {
  return (
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.TOOL_BASE_URL ||
    ''
  ).replace(/\/$/, '');
}

/** Kick the Netlify background worker (or run inline in local/dev). */
export async function kickJevWorker(jobId: string): Promise<'inline' | 'background' | 'queued'> {
  if (jevInline()) {
    void import('../dispatch')
      .then(({ runJevJobById }) => runJevJobById(jobId))
      .catch((e) => console.error('[jev] inline job failed', jobId, e));
    return 'inline';
  }

  const origin = siteOrigin();
  if (!origin) return 'queued';

  const secret = process.env.CRON_SECRET || process.env.APIFY_WEBHOOK_SECRET || '';
  try {
    await fetch(`${origin}/.netlify/functions/jev-jobs-background`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'x-cron-secret': secret } : {}),
      },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(8_000),
    });
    return 'background';
  } catch {
    return 'queued';
  }
}

export async function enqueue(type: JobType, payload: Record<string, unknown>, projectId?: string | null) {
  const row = must(
    await db().from('jev_jobs').insert({ type, payload, project_id: projectId ?? null }).select('id').single(),
  ) as { id: string };
  await kickJevWorker(row.id);
  return row;
}

export class CancelledError extends Error {
  constructor() { super('Annullato'); }
}

export async function progress(jobId: string | undefined, text: string) {
  if (!jobId) return;
  const { data } = await db().from('jev_jobs').update({ progress: text }).eq('id', jobId).neq('status', 'cancelled').select('id');
  if (!data?.length) throw new CancelledError();
}

export async function cancelJob(jobId: string) {
  await db().from('jev_jobs').update({ status: 'cancelled', finished_at: new Date().toISOString(), progress: 'annullato' }).eq('id', jobId).in('status', ['queued', 'running']);
}
