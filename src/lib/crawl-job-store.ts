/**
 * In-memory job store per crawl in background.
 * Jobs are lost on server restart, but crawls typically complete within a few minutes.
 */
import type { FunnelCrawlResult } from '@/types';

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

const jobs = new Map<string, CrawlJob>();

export function createJob(entryUrl: string, params: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const now = new Date();
  jobs.set(id, {
    id,
    status: 'pending',
    entryUrl,
    params,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export function getJob(id: string): CrawlJob | undefined {
  return jobs.get(id);
}

export function updateJob(
  id: string,
  update: Partial<Pick<CrawlJob, 'status' | 'result' | 'error' | 'currentStep' | 'totalSteps'>>
): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, update, { updatedAt: new Date() });
}
