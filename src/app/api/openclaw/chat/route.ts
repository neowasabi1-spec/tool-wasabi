import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 120;

const OPENCLAW_BASE_URL = process.env.OPENCLAW_BASE_URL || 'https://soil-rendered-abstracts-photography.trycloudflare.com';
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY || 'a353475b70538480030b744771524d183521a46ab8db7b02a2846d1103bc5734';
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || 'merlino';

const DEFAULT_SYSTEM = `You are OpenClaw, an AI agent with browser navigation skills. You can browse websites, analyze funnels, extract data from landing pages, and provide detailed reports. When asked to navigate a URL, describe what you see on the page including: headlines, CTAs, images, forms, pricing, testimonials, and the overall funnel structure. Provide actionable insights for affiliate marketers. Respond in the same language as the user.`;

async function callOpenClaw(messages: { role: string; content: string }[]) {
  const url = `${OPENCLAW_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCLAW_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENCLAW_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(110_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenClaw HTTP ${res.status}: ${body.substring(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

export async function POST(req: NextRequest) {
  if (!OPENCLAW_BASE_URL) {
    return NextResponse.json({ error: 'OPENCLAW_BASE_URL not configured' }, { status: 500 });
  }

  const { messages, systemPrompt } = await req.json();

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'Missing or invalid messages array' }, { status: 400 });
  }

  const openclawMessages: { role: string; content: string }[] = [
    { role: 'system', content: systemPrompt || DEFAULT_SYSTEM },
  ];

  for (const m of messages) {
    if (m.role !== 'system') {
      openclawMessages.push({ role: m.role, content: m.content });
    }
  }

  try {
    const content = await callOpenClaw(openclawMessages);
    return NextResponse.json({ content, model: OPENCLAW_MODEL });
  } catch (err) {
    console.error('OpenClaw error:', (err as Error).message);
    return NextResponse.json(
      { error: `OpenClaw connection failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

export async function GET() {
  if (!OPENCLAW_BASE_URL) {
    return NextResponse.json({ status: 'offline', message: 'OPENCLAW_BASE_URL not set' }, { status: 502 });
  }

  try {
    const url = `${OPENCLAW_BASE_URL.replace(/\/$/, '')}/v1/models`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${OPENCLAW_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      return NextResponse.json({
        status: 'online',
        baseUrl: OPENCLAW_BASE_URL,
        model: OPENCLAW_MODEL,
      });
    }

    return NextResponse.json({ status: 'offline', message: `HTTP ${res.status}` }, { status: 502 });
  } catch (err) {
    return NextResponse.json({ status: 'offline', message: (err as Error).message }, { status: 502 });
  }
}
