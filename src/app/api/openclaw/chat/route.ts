import { NextRequest, NextResponse } from 'next/server';
import { getOpenClawConfig } from '@/lib/openclaw-config';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { messages, stream = false, systemPrompt } = await req.json();

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'Missing or invalid messages array' }, { status: 400 });
  }

  const config = await getOpenClawConfig();
  if (!config.apiKey) {
    return NextResponse.json({ error: 'OpenClaw API key not configured' }, { status: 500 });
  }

  const defaultSystem = `You are OpenClaw, an AI agent with browser navigation skills. You can browse websites, analyze funnels, extract data from landing pages, and provide detailed reports. When asked to navigate a URL, describe what you see on the page including: headlines, CTAs, images, forms, pricing, testimonials, and the overall funnel structure. Provide actionable insights for affiliate marketers.`;

  const systemMessage = {
    role: 'system',
    content: systemPrompt || defaultSystem,
  };

  const payload = {
    model: config.model,
    messages: [systemMessage, ...messages],
    temperature: 0.7,
    max_tokens: 2048,
    stream: true,
  };

  try {
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

    if (stream) {
      return new Response(res.body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // Non-stream mode: collect SSE chunks into a single response
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const json = JSON.parse(line.slice(6));
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) fullContent += delta;
            } catch { /* skip malformed */ }
          }
        }
      }
    }

    return NextResponse.json({ content: fullContent, model: config.model });
  } catch (err) {
    return NextResponse.json(
      { error: `OpenClaw connection failed: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

export async function GET() {
  const config = await getOpenClawConfig();
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
