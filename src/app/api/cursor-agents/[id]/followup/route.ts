import { NextRequest, NextResponse } from 'next/server';

const CURSOR_API_BASE = 'https://api.cursor.com/v0';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'CURSOR_API_KEY is not configured' },
      { status: 500 }
    );
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Agent id is required' },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();
    const { prompt } = body;

    if (!prompt?.text) {
      return NextResponse.json(
        { success: false, error: 'prompt.text is required' },
        { status: 400 }
      );
    }

    const payload: Record<string, unknown> = {
      prompt: {
        text: prompt.text,
        ...(Array.isArray(prompt.images) && prompt.images.length > 0 && { images: prompt.images }),
      },
    };

    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const response = await fetch(`${CURSOR_API_BASE}/agents/${id}/followup`, {
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

    return NextResponse.json({ success: true, data: { id, ...data } });
  } catch (error) {
    console.error('Cursor agents followup error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Request failed',
      },
      { status: 503 }
    );
  }
}
