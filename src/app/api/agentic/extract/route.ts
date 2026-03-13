import { NextRequest, NextResponse } from 'next/server';

function getAgenticApiBase() {
  return process.env.AGENTIC_API_URL || 'http://localhost:8000';
}

export async function POST(request: NextRequest) {
  const AGENTIC_API_BASE = getAgenticApiBase();
  try {
    const body = await request.json();
    
    if (!body.url) {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 }
      );
    }

    const startTime = Date.now();

    const response = await fetch(`${AGENTIC_API_BASE}/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: body.url,
      }),
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { 
          success: false, 
          error: `Extract failed: ${response.status}`,
          details: errorText,
          duration_ms: duration,
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    return NextResponse.json({
      success: true,
      duration_ms: duration,
      ...data,
    });

  } catch (error) {
    console.error('Error calling agentic extract API:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Request failed',
      },
      { status: 500 }
    );
  }
}
