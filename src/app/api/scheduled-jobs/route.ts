import { NextRequest, NextResponse } from 'next/server';
import {
  fetchScheduledBrowserJobs,
  createScheduledBrowserJob,
  deleteScheduledBrowserJob,
  toggleScheduledBrowserJob,
  updateScheduledBrowserJob,
} from '@/lib/supabase-operations';

/**
 * GET /api/scheduled-jobs
 * List all scheduled jobs
 */
export async function GET() {
  try {
    const jobs = await fetchScheduledBrowserJobs();
    return NextResponse.json({ success: true, jobs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Failed to fetch scheduled jobs: ${message}` },
      { status: 500 }
    );
  }
}

/**
 * POST /api/scheduled-jobs
 * Create a new scheduled job
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { templateId, title, prompt, startUrl, maxTurns, category, tags, frequency } = body;

    if (!prompt || !title) {
      return NextResponse.json(
        { success: false, error: 'Title and prompt are required' },
        { status: 400 }
      );
    }

    const job = await createScheduledBrowserJob({
      template_id: templateId || 'custom',
      title: title.trim(),
      prompt: prompt.trim(),
      start_url: startUrl?.trim() || null,
      max_turns: Math.min(Math.max(maxTurns || 100, 5), 500),
      category: category || 'custom',
      tags: tags || [],
      frequency: frequency || 'daily',
      is_active: true,
    });

    return NextResponse.json({ success: true, job });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Failed to create scheduled job: ${message}` },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/scheduled-jobs
 * Update a job (toggle active/inactive, update frequency, etc.)
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, action, ...updates } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Job ID is required' },
        { status: 400 }
      );
    }

    let job;

    if (action === 'toggle') {
      job = await toggleScheduledBrowserJob(id, updates.isActive);
    } else {
      const updatePayload: Record<string, unknown> = {};
      if (updates.frequency) updatePayload.frequency = updates.frequency;
      if (updates.prompt) updatePayload.prompt = updates.prompt;
      if (updates.title) updatePayload.title = updates.title;
      if (updates.maxTurns) updatePayload.max_turns = updates.maxTurns;
      if (updates.startUrl !== undefined) updatePayload.start_url = updates.startUrl || null;

      job = await updateScheduledBrowserJob(id, updatePayload);
    }

    return NextResponse.json({ success: true, job });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Failed to update scheduled job: ${message}` },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/scheduled-jobs
 * Delete a scheduled job
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Job ID is required' },
        { status: 400 }
      );
    }

    await deleteScheduledBrowserJob(id);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Failed to delete scheduled job: ${message}` },
      { status: 500 }
    );
  }
}
