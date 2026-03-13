import { NextRequest, NextResponse } from 'next/server';
import {
  fetchDueScheduledJobs,
  updateScheduledBrowserJob,
  calculateNextRunAt,
  createAffiliateBrowserChat,
} from '@/lib/supabase-operations';

function getApiUrl() {
  return process.env.AGENTIC_BROWSER_API_URL || 'http://localhost:8000';
}
function getCronSecret() {
  return process.env.CRON_SECRET || '';
}

/**
 * GET /api/scheduled-jobs/cron
 * 
 * Endpoint to be called via cron (e.g. every hour or every day).
 * Trova tutti i job schedulati con next_run_at <= now() e li esegue.
 * 
 * Can be called from:
 * - Fly.io Machine cron
 * - External cron service (cron-job.org, Upstash, etc.)
 * - GitHub Actions scheduled workflow
 * 
 * Protezione: header Authorization o query param ?secret=...
 */
export async function GET(request: NextRequest) {
  const API_URL = getApiUrl();
  const CRON_SECRET = getCronSecret();

  // Security: verify cron secret if configured
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    const secretParam = new URL(request.url).searchParams.get('secret');
    const providedSecret = authHeader?.replace('Bearer ', '') || secretParam;

    if (providedSecret !== CRON_SECRET) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }
  }

  try {
    const dueJobs = await fetchDueScheduledJobs();

    if (dueJobs.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No jobs due for execution',
        jobsChecked: 0,
        jobsStarted: 0,
      });
    }

    const results: Array<{
      jobId: string;
      title: string;
      status: 'started' | 'error';
      remoteJobId?: string;
      error?: string;
    }> = [];

    for (const scheduledJob of dueJobs) {
      try {
        const effectiveStartUrl = scheduledJob.start_url || 'https://google.com';
        const effectiveMaxTurns = Math.min(Math.max(scheduledJob.max_turns, 1), 500);

        // Start the remote agentic browser job
        const response = await fetch(`${API_URL}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: scheduledJob.prompt,
            start_url: effectiveStartUrl,
            max_turns: effectiveMaxTurns,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        const remoteJobId = data.job_id;

        // Save to affiliate_browser_chats for tracking
        try {
          await createAffiliateBrowserChat({
            prompt: `[SCHEDULED] ${scheduledJob.title}: ${scheduledJob.prompt}`,
            start_url: scheduledJob.start_url,
            max_turns: effectiveMaxTurns,
            job_id: remoteJobId,
            status: data.status || 'queued',
          });
        } catch {
          // Non-blocking
        }

        // Update the scheduled job
        const nextRunAt = calculateNextRunAt(scheduledJob.frequency);
        await updateScheduledBrowserJob(scheduledJob.id, {
          last_run_at: new Date().toISOString(),
          last_job_id: remoteJobId,
          last_status: 'running',
          last_error: null,
          total_runs: scheduledJob.total_runs + 1,
          next_run_at: nextRunAt,
        });

        results.push({
          jobId: scheduledJob.id,
          title: scheduledJob.title,
          status: 'started',
          remoteJobId,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';

        // Update the scheduled job with error but still advance next_run_at
        const nextRunAt = calculateNextRunAt(scheduledJob.frequency);
        try {
          await updateScheduledBrowserJob(scheduledJob.id, {
            last_run_at: new Date().toISOString(),
            last_status: 'error',
            last_error: errorMsg,
            total_runs: scheduledJob.total_runs + 1,
            next_run_at: nextRunAt,
          });
        } catch {
          // Non-blocking
        }

        results.push({
          jobId: scheduledJob.id,
          title: scheduledJob.title,
          status: 'error',
          error: errorMsg,
        });
      }
    }

    const started = results.filter((r) => r.status === 'started').length;
    const errors = results.filter((r) => r.status === 'error').length;

    return NextResponse.json({
      success: true,
      message: `Processed ${dueJobs.length} scheduled jobs: ${started} started, ${errors} errors`,
      jobsChecked: dueJobs.length,
      jobsStarted: started,
      jobsErrored: errors,
      results,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Cron execution failed: ${message}` },
      { status: 500 }
    );
  }
}
