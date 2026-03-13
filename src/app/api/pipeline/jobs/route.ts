import { NextRequest, NextResponse } from 'next/server';

const PIPELINE_API_BASE = 'https://claude-code-agents.fly.dev';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    
    // Build query params for filtering
    const queryParams = new URLSearchParams();
    
    const projectId = searchParams.get('project_id');
    const userId = searchParams.get('user_id');
    const limit = searchParams.get('limit');
    const status = searchParams.get('status');
    
    if (projectId) queryParams.append('project_id', projectId);
    if (userId) queryParams.append('user_id', userId);
    if (limit) queryParams.append('limit', limit);
    if (status) queryParams.append('status', status);
    
    const queryString = queryParams.toString();
    const url = queryString 
      ? `${PIPELINE_API_BASE}/api/pipeline/jobs?${queryString}`
      : `${PIPELINE_API_BASE}/api/pipeline/jobs`;

    const response = await fetch(url, {
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

    return NextResponse.json(data);
  } catch (error) {
    console.error('Pipeline jobs list proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Network error' },
      { status: 500 }
    );
  }
}
