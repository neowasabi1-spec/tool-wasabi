import { NextRequest, NextResponse } from 'next/server';

function getAgenticApiBase() {
  return process.env.AGENTIC_API_URL || 'http://localhost:8000';
}

export type PromptType = 'visual_analysis' | 'conversion_optimization' | 'ux_audit' | 'brand_analysis' | 'custom';

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

    const payload: Record<string, unknown> = {
      url: body.url,
      prompt_type: body.prompt_type || 'visual_analysis',
    };

    // Add custom prompt if provided
    if (body.custom_prompt) {
      payload.custom_prompt = body.custom_prompt;
    }

    const response = await fetch(`${AGENTIC_API_BASE}/vision`, {
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
          error: `Vision analysis failed: ${response.status}`,
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
      prompt_type: body.prompt_type || 'visual_analysis',
      ...data,
    });

  } catch (error) {
    console.error('Error calling agentic vision API:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Request failed',
      },
      { status: 500 }
    );
  }
}
