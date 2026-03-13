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

    const payload = {
      url: body.url,
      include_scrape: body.include_scrape ?? true,
      include_vision: body.include_vision ?? true,
      include_extract: body.include_extract ?? true,
      prompt_type: body.prompt_type || 'visual_analysis',
      custom_prompt: body.custom_prompt,
    };

    const response = await fetch(`${AGENTIC_API_BASE}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { 
          success: false, 
          error: `Full analysis failed: ${response.status}`,
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
      analysis_config: {
        include_scrape: payload.include_scrape,
        include_vision: payload.include_vision,
        include_extract: payload.include_extract,
      },
      ...data,
    });

  } catch (error) {
    console.error('Error calling agentic analyze API:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Request failed',
      },
      { status: 500 }
    );
  }
}
