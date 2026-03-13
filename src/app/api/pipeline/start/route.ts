import { NextRequest, NextResponse } from 'next/server';

const PIPELINE_API_BASE = 'https://claude-code-agents.fly.dev';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Build query params from body
    const params = new URLSearchParams();
    
    // Required params
    if (body.url) params.append('url', body.url);
    if (body.product_name) params.append('product_name', body.product_name);
    if (body.product_description) params.append('product_description', body.product_description);
    if (body.cta_text) params.append('cta_text', body.cta_text);
    if (body.cta_url) params.append('cta_url', body.cta_url);
    if (body.language) params.append('language', body.language);
    if (body.brand_name) params.append('brand_name', body.brand_name);
    
    // Project tracking params (NEW)
    if (body.project_id) params.append('project_id', body.project_id);
    if (body.user_id) params.append('user_id', body.user_id);
    
    // Add benefits as multiple params
    if (body.benefits && Array.isArray(body.benefits)) {
      body.benefits.forEach((benefit: string) => {
        if (benefit.trim()) {
          params.append('benefits', benefit.trim());
        }
      });
    }

    const response = await fetch(`${PIPELINE_API_BASE}/api/pipeline/jobs/start?${params.toString()}`, {
      method: 'POST',
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
    console.error('Pipeline start proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Network error' },
      { status: 500 }
    );
  }
}
