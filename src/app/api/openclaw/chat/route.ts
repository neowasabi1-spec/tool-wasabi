import { NextRequest, NextResponse } from 'next/server';

const getConfig = () => ({
  baseUrl: process.env.OPENCLAW_BASE_URL || 'http://69.197.168.23:19001',
  apiKey: process.env.OPENCLAW_API_KEY || '',
  model: process.env.OPENCLAW_MODEL || 'openclaw:neo',
});

export async function POST(req: NextRequest) {
  const { messages, stream = false } = await req.json();

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'Missing or invalid messages array' }, { status: 400 });
  }

  const config = getConfig();
  if (!config.apiKey) {
    return NextResponse.json({ error: 'OpenClaw API key not configured' }, { status: 500 });
  }

  const systemMessage = {
    role: 'system',
    content: `You are OpenClaw, an AI agent with browser navigation skills. You can browse websites, analyze funnels, extract data from landing pages, and provide detailed reports. When asked to navigate a URL, describe what you see on the page including: headlines, CTAs, images, forms, pricing, testimonials, and the overall funnel structure. Provide actionable insights for affiliate marketers.`,
  };

  const payload = {
    model: config.model,
    messages: [systemMessage, ...messages],
    temperature: 0.7,
    max_tokens: 4096,
    stream,
  };

  try {
    if (stream) {
      const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text();
        return NextResponse.json(
          { error: `OpenClaw error: ${res.status} - ${errText}` },
          { status: res.status }
        );
      }

      return new Response(res.body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json(
        { error: `OpenClaw error: ${res.status} - ${errText}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';

    return NextResponse.json({
      content,
      model: data.model,
      usage: data.usage,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `OpenClaw connection failed: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

export async function GET() {
  const config = getConfig();
  try {
    const res = await fetch(`${config.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return NextResponse.json({ status: 'online', baseUrl: config.baseUrl, model: config.model });
    }
    return NextResponse.json({ status: 'error', message: `HTTP ${res.status}` }, { status: 502 });
  } catch {
    return NextResponse.json({ status: 'offline', baseUrl: config.baseUrl }, { status: 502 });
  }
}
