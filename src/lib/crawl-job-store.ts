/**
 * Persistent job store for Funnel Analyzer crawls, backed by the
 * `funnel_crawl_jobs` Supabase table (see
 * `supabase-migration-funnel-crawl-jobs.sql`).
 *
 * Why Supabase instead of an in-memory `Map`?
 * On Netlify (and any serverless platform) every request can land on
 * a different lambda container. The original implementation kept the
 * job dictionary in process memory, so:
 *   - POST /crawl/start   → job written to container A's Map
 *   - GET  /crawl/status  → request lands on container B → "Job not
 *     found" until container A happens to receive the next poll, if
 *     ever (most of the time it doesn't because the lambda is gone
 *     once the response is sent).
 * Persisting to Supabase makes the store horizontally consistent
 * across containers and across cold starts, so the polling client
 * can always find the job it just created.
 *
 * All three exports are now async (the previous sync signatures were
 * a side-effect of the in-memory implementation). Callers must
 * `await` them.
 */
import type { FunnelCrawlResult } from '@/types';
import { supabase } from './supabase';

export type CrawlJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface CrawlJob {
  id: string;
  status: CrawlJobStatus;
  entryUrl: string;
  params: Record<string, unknown>;
  result?: FunnelCrawlResult;
  error?: string;
  currentStep?: number;
  totalSteps?: number;
  createdAt: Date;
  updatedAt: Date;
}

interface CrawlJobRow {
  id: string;
  status: CrawlJobStatus;
  entry_url: string;
  params: Record<string, unknown> | null;
  result: FunnelCrawlResult | null;
  error: string | null;
  current_step: number | null;
  total_steps: number | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: CrawlJobRow): CrawlJob {
  return {
    id: row.id,
    status: row.status,
    entryUrl: row.entry_url,
    params: row.params ?? {},
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    currentStep: row.current_step ?? undefined,
    totalSteps: row.total_steps ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export async function createJob(
  entryUrl: string,
  params: Record<string, unknown>,
  targetAgent?: string | null,
): Promise<string> {
  const insertRow: Record<string, unknown> = {
    status: 'pending',
    entry_url: entryUrl,
    params,
    current_step: 0,
    total_steps: 0,
  };
  // Only set the column if the caller cares; if the migration
  // (supabase-migration-funnel-crawl-jobs-target-agent.sql) hasn't
  // been applied yet PostgREST will reject the insert with
  // "Could not find the 'target_agent' column", so we leave it out
  // entirely when the caller doesn't pass anything.
  if (targetAgent) {
    insertRow.target_agent = targetAgent;
  }

  const { data, error } = await supabase
    .from('funnel_crawl_jobs')
    .insert(insertRow)
    .select('id')
    .single();
  if (error) {
    // Self-healing: if the column is missing, retry without it so the
    // crawl still works (it just becomes first-come-first-served).
    if (
      targetAgent &&
      /target_agent/i.test(error.message)
    ) {
      console.warn(
        `[crawl-job-store] target_agent column missing — retrying without it. ` +
          `Apply supabase-migration-funnel-crawl-jobs-target-agent.sql to enable agent routing.`,
      );
      delete insertRow.target_agent;
      const retry = await supabase
        .from('funnel_crawl_jobs')
        .insert(insertRow)
        .select('id')
        .single();
      if (retry.error) {
        throw new Error(
          `createJob failed: ${retry.error.message}. Did you apply supabase-migration-funnel-crawl-jobs.sql?`,
        );
      }
      return retry.data.id as string;
    }
    throw new Error(
      `createJob failed: ${error.message}. Did you apply supabase-migration-funnel-crawl-jobs.sql?`,
    );
  }
  return data.id as string;
}

export async function getJob(id: string): Promise<CrawlJob | undefined> {
  const { data, error } = await supabase
    .from('funnel_crawl_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new Error(`getJob failed: ${error.message}`);
  }
  if (!data) return undefined;
  return rowToJob(data as CrawlJobRow);
}

export async function updateJob(
  id: string,
  update: Partial<
    Pick<CrawlJob, 'status' | 'result' | 'error' | 'currentStep' | 'totalSteps'>
  >,
): Promise<void> {
  const dbUpdate: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (update.status !== undefined) dbUpdate.status = update.status;
  if (update.result !== undefined) dbUpdate.result = update.result;
  if (update.error !== undefined) dbUpdate.error = update.error;
  if (update.currentStep !== undefined) dbUpdate.current_step = update.currentStep;
  if (update.totalSteps !== undefined) dbUpdate.total_steps = update.totalSteps;

  const { error } = await supabase
    .from('funnel_crawl_jobs')
    .update(dbUpdate)
    .eq('id', id);
  if (error) {
    // Don't throw — a failed progress write must never abort an
    // in-flight crawl. Just log it; the next updateJob call will
    // overwrite this row anyway.
    console.warn(`[crawl-job-store] updateJob ${id} failed: ${error.message}`);
  }
}
