import { NextRequest, NextResponse } from 'next/server';

const PIPELINE_API_BASE = 'https://claude-code-agents.fly.dev';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format');

    if (!jobId) {
      return NextResponse.json(
        { error: 'Job ID is required' },
        { status: 400 }
      );
    }

    // Check if JSON format requested
    const endpoint = format === 'json' 
      ? `${PIPELINE_API_BASE}/api/pipeline/jobs/${jobId}/result/json`
      : `${PIPELINE_API_BASE}/api/pipeline/jobs/${jobId}/result`;

    const response = await fetch(endpoint, {
      method: 'GET',
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return NextResponse.json(
        { error: data.error || `API error: ${response.status}` },
        { status: response.status }
      );
    }

    if (format === 'json') {
      const data = await response.json();
      return NextResponse.json(data);
    }

    // Get the HTML content
    const html = await response.text();

    // Return as HTML
    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  } catch (error) {
    console.error('Pipeline result proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Network error' },
      { status: 500 }
    );
  }
}
