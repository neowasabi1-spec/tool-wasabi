import { NextRequest, NextResponse } from 'next/server';
import { queueAndWait } from '@/lib/openclaw-queue';
import { supabase } from '@/lib/supabase';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const { messages, systemPrompt } = await req.json();

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'Missing or invalid messages array' }, { status: 400 });
  }

  const defaultSystem = `You are OpenClaw, an AI agent with browser navigation skills. You can browse websites, analyze funnels, extract data from landing pages, and provide detailed reports. When asked to navigate a URL, describe what you see on the page including: headlines, CTAs, images, forms, pricing, testimonials, and the overall funnel structure. Provide actionable insights for affiliate marketers.`;

  const lastUserMsg = [...messages].reverse().find((m: { role: string }) => m.role === 'user');
  if (!lastUserMsg) {
    return NextResponse.json({ error: 'No user message found' }, { status: 400 });
  }

  const history = messages
    .filter((m: { role: string }) => m.role !== 'system')
    .slice(0, -1)
    .map((m: { role: string; content: string }) => ({ role: m.role, content: m.content }));

  try {
    const content = await queueAndWait(lastUserMsg.content, {
      systemPrompt: systemPrompt || defaultSystem,
      section: 'Affiliate Browser Chat',
      chatHistory: history.length > 0 ? history : undefined,
      timeoutMs: 110_000,
    });

    return NextResponse.json({ content, model: 'openclaw-gateway' });
  } catch (err) {
    return NextResponse.json(
      { error: `OpenClaw connection failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

export async function GET() {
  try {
    const { count, error } = await supabase
      .from('openclaw_messages')
      .select('*', { count: 'exact', head: true });

    if (error) {
      return NextResponse.json({ status: 'offline', message: error.message }, { status: 502 });
    }

    return NextResponse.json({
      status: 'online',
      baseUrl: 'ws://gateway (via Supabase queue)',
      model: 'openclaw-gateway',
      queueSize: count ?? 0,
    });
  } catch {
    return NextResponse.json({ status: 'offline' }, { status: 502 });
  }
}
