import { NextRequest, NextResponse } from 'next/server';
import { updateAffiliateBrowserChatByJobId } from '@/lib/supabase-operations';

function getApiUrl() {
  return process.env.AGENTIC_BROWSER_API_URL || 'http://localhost:8000';
}

const FINISHED_STATUSES = ['completed', 'max_turns', 'blocked', 'error'];

export async function GET(request: NextRequest) {
  const API_URL = getApiUrl();
  try {
    const jobId = request.nextUrl.searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'jobId parameter is required' },
        { status: 400 }
      );
    }

    const response = await fetch(`${API_URL}/jobs/${jobId}`);

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json(
          { success: false, error: 'Job not found' },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { success: false, error: `Agentic API error: ${response.status}` },
        { status: response.status }
      );
    }

    const job = await response.json();

    const mappedJob = {
      id: job.id,
      status: job.status,
      prompt: job.prompt,
      startUrl: job.start_url,
      maxTurns: job.max_turns,
      currentTurn: job.current_turn,
      turnsUsed: job.turns_used,
      currentUrl: job.current_url,
      lastActions: job.last_actions || [],
      lastText: job.last_text || '',
      debugUrl: job.debug_url || null,
      result: job.result || null,
      error: job.error || null,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      finishedAt: job.finished_at,
    };

    // Update database when job reaches a finished status
    if (FINISHED_STATUSES.includes(job.status)) {
      try {
        await updateAffiliateBrowserChatByJobId(jobId, {
          status: job.status,
          result: job.result || null,
          error: job.error || null,
          turns_used: job.turns_used || job.current_turn || 0,
          final_url: job.current_url || null,
          finished_at: job.finished_at || new Date().toISOString(),
        });
      } catch (dbError) {
        console.error('Failed to update chat in database (non-blocking):', dbError);
      }
    } else {
      // Update status and progress for running jobs
      try {
        await updateAffiliateBrowserChatByJobId(jobId, {
          status: job.status,
          turns_used: job.current_turn || 0,
          final_url: job.current_url || null,
        });
      } catch (dbError) {
        console.error('Failed to update chat progress in database (non-blocking):', dbError);
      }
    }

    return NextResponse.json({
      success: true,
      job: mappedJob,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Failed to poll job: ${message}` },
      { status: 500 }
    );
  }
}
