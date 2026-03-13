import { NextRequest, NextResponse } from 'next/server';

const VISION_API_BASE = 'https://claude-code-agents.fly.dev/api/vision';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id') || 'default';
    const limit = searchParams.get('limit') || '50';
    const status = searchParams.get('status'); // Optional filter by status

    // Build query string
    const queryParams = new URLSearchParams({
      project_id: projectId,
      limit: limit,
    });
    
    if (status) {
      queryParams.append('status', status);
    }

    const response = await fetch(`${VISION_API_BASE}/jobs?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { 
          success: false, 
          error: `Vision API error: ${response.status}`,
          details: errorText 
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    return NextResponse.json({
      success: true,
      jobs: data.jobs || data,
      total: data.total || (data.jobs ? data.jobs.length : 0),
    });

  } catch (error) {
    console.error('Error fetching vision jobs:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}
