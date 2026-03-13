import { NextResponse } from 'next/server';

function getApiUrl() {
  return process.env.AGENTIC_BROWSER_API_URL || 'http://localhost:8000';
}

export async function GET() {
  const API_URL = getApiUrl();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${API_URL}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json({
        success: false,
        agenticServer: 'error',
        error: `Status ${response.status}`,
      });
    }

    const data = await response.json();

    return NextResponse.json({
      success: true,
      agenticServer: 'online',
      activeJobs: data.active_jobs || 0,
      details: data,
    });
  } catch {
    return NextResponse.json({
      success: false,
      agenticServer: 'offline',
      error: `Cannot reach agentic server at ${API_URL}`,
    });
  }
}
