import { NextRequest, NextResponse } from 'next/server';
import { createAffiliateBrowserChat } from '@/lib/supabase-operations';

function getApiUrl() {
  return process.env.AGENTIC_BROWSER_API_URL || 'http://localhost:8000';
}

export async function POST(request: NextRequest) {
  const API_URL = getApiUrl();
  try {
    const body = await request.json();
    const { prompt, startUrl, maxTurns = 100 } = body;

    if (!prompt || prompt.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'Prompt is required' },
        { status: 400 }
      );
    }

    const effectiveStartUrl = startUrl || 'https://google.com';
    const effectiveMaxTurns = Math.min(Math.max(maxTurns, 1), 500);

    const response = await fetch(`${API_URL}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        start_url: effectiveStartUrl,
        max_turns: effectiveMaxTurns,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { success: false, error: `Agentic API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Save the prompt and job info to Supabase
    try {
      await createAffiliateBrowserChat({
        prompt: prompt.trim(),
        start_url: startUrl?.trim() || null,
        max_turns: effectiveMaxTurns,
        job_id: data.job_id,
        status: data.status || 'queued',
      });
    } catch (dbError) {
      console.error('Failed to save prompt to database (non-blocking):', dbError);
    }

    return NextResponse.json({
      success: true,
      jobId: data.job_id,
      status: data.status,
      message: data.message,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const isConnectionError = message.includes('ECONNREFUSED') || message.includes('fetch failed');
    return NextResponse.json(
      {
        success: false,
        error: isConnectionError
          ? `Cannot reach agentic server at ${API_URL}. Is it running?`
          : `Failed to start agent: ${message}`,
      },
      { status: isConnectionError ? 503 : 500 }
    );
  }
}
