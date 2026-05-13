import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const { message, systemPrompt, section, chatHistory, targetAgent } =
    await req.json();
  if (!message) return NextResponse.json({ error: 'Missing message' }, { status: 400 });

  // `targetAgent` (e.g. "openclaw:neo", "openclaw:morfeo") routes the
  // job to a specific worker. Without it, ANY worker can claim the
  // row (legacy first-come-first-served behaviour). Used by the
  // clone-landing / agentic-swipe / checkpoint UIs to honor an
  // explicit auditor selection without changing the worker poll
  // logic — workers already filter by `target_agent.is.null OR
  // target_agent.eq.<their-agent>`.
  const insert: Record<string, unknown> = {
    user_message: message,
    system_prompt: systemPrompt || null,
    section: section || 'Dashboard',
    chat_history: chatHistory ? JSON.stringify(chatHistory) : null,
    status: 'pending',
  };
  if (typeof targetAgent === 'string' && targetAgent.trim()) {
    insert.target_agent = targetAgent.trim();
  }

  const { data, error } = await supabase
    .from('openclaw_messages')
    .insert(insert)
    .select('id')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ id: data.id, status: 'pending' });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  const debug = req.nextUrl.searchParams.get('debug');

  // Debug: show all recent messages status
  if (debug === '1') {
    const { data, error } = await supabase
      .from('openclaw_messages')
      .select('id, status, section, created_at, completed_at, error_message, user_message')
      .order('created_at', { ascending: false })
      .limit(10);
    return NextResponse.json({ messages: data, error: error?.message });
  }

  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { data, error } = await supabase
    .from('openclaw_messages')
    .select('status, response, error_message')
    .eq('id', id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    status: data.status,
    content: data.response,
    error: data.error_message,
  });
}
