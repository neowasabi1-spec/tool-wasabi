import { NextRequest, NextResponse } from 'next/server';

const CURSOR_API_BASE = 'https://api.cursor.com/v0';

export async function POST(request: NextRequest) {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'CURSOR_API_KEY is not configured' },
      { status: 500 }
    );
  }

  try {
    const body = await request.json();
    const { prompt, model, source, target, webhook } = body;

    if (!prompt?.text) {
      return NextResponse.json(
        { success: false, error: 'prompt.text is required' },
        { status: 400 }
      );
    }
    if (!source?.repository && !source?.prUrl) {
      return NextResponse.json(
        { success: false, error: 'source.repository or source.prUrl is required' },
        { status: 400 }
      );
    }

    const payload: Record<string, unknown> = {
      prompt: {
        text: prompt.text,
        ...(Array.isArray(prompt.images) && prompt.images.length > 0 && { images: prompt.images }),
      },
      source: {
        ...(source.repository && { repository: source.repository }),
        ...(source.ref && { ref: source.ref }),
        ...(source.prUrl && { prUrl: source.prUrl }),
      },
    };
    if (model) payload.model = model;
    if (target && typeof target === 'object') payload.target = target;
    if (webhook && typeof webhook === 'object') payload.webhook = webhook;

    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const response = await fetch(`${CURSOR_API_BASE}/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error: data.message || data.error || `Cursor API error: ${response.status}`,
          details: data,
        },
        { status: response.status }
      );
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Cursor agents launch error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Request failed',
      },
      { status: 503 }
    );
  }
}
