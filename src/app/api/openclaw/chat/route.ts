import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const maxDuration = 60;

const DEFAULT_SYSTEM = `You are OpenClaw, an AI agent with browser navigation skills. You can browse websites, analyze funnels, extract data from landing pages, and provide detailed reports. When asked to navigate a URL, describe what you see on the page including: headlines, CTAs, images, forms, pricing, testimonials, and the overall funnel structure. Provide actionable insights for affiliate marketers. Respond in the same language as the user.`;

export async function POST(req: NextRequest) {
  const { messages, systemPrompt } = await req.json();

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'Missing or invalid messages array' }, { status: 400 });
  }

  const lastMessage = messages.filter((m: { role: string }) => m.role === 'user').pop();
  if (!lastMessage) {
    return NextResponse.json({ error: 'No user message found' }, { status: 400 });
  }

  const chatHistory = messages
    .filter((m: { role: string }) => m.role !== 'system')
    .slice(0, -1)
    .map((m: { role: string; content: string }) => ({ role: m.role, content: m.content }));

  const { data, error } = await supabase
    .from('openclaw_messages')
    .insert({
      user_message: lastMessage.content,
      system_prompt: systemPrompt || DEFAULT_SYSTEM,
      chat_history: chatHistory.length > 0 ? JSON.stringify(chatHistory) : null,
      section: 'Affiliate Browser Chat',
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const msgId = data.id;

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const { data: poll } = await supabase
      .from('openclaw_messages')
      .select('status, response, error_message')
      .eq('id', msgId)
      .single();

    if (poll?.status === 'completed') {
      return NextResponse.json({ content: poll.response, model: 'openclaw:neo' });
    }
    if (poll?.status === 'error') {
      return NextResponse.json(
        { error: `OpenClaw error: ${poll.error_message}` },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({ error: 'OpenClaw response timeout' }, { status: 504 });
}

export async function GET() {
  try {
    const { error } = await supabase.from('openclaw_messages').select('id').limit(1);
    if (error) throw error;
    return NextResponse.json({ status: 'online', mode: 'queue' });
  } catch {
    return NextResponse.json({ status: 'offline', message: 'Queue not available' }, { status: 502 });
  }
}
