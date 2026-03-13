import { NextRequest, NextResponse } from 'next/server';

const PIPELINE_API_BASE = 'https://claude-code-agents.fly.dev';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;

    if (!jobId) {
      return NextResponse.json(
        { error: 'Job ID is required' },
        { status: 400 }
      );
    }

    const response = await fetch(`${PIPELINE_API_BASE}/api/pipeline/jobs/${jobId}/status`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { error: data.error || `API error: ${response.status}` },
        { status: response.status }
      );
    }

    // Response includes vision_job_id when Layer 1 (screenshot + vision) is complete
    // Example response:
    // {
    //   status: 'running' | 'completed' | 'failed',
    //   progress: 50,
    //   current_layer: 'layer_2_html',
    //   vision_job_id: 'uuid...',  // Available after Layer 1
    //   ...
    // }
    
    return NextResponse.json(data);
  } catch (error) {
    console.error('Pipeline status proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Network error' },
      { status: 500 }
    );
  }
}
