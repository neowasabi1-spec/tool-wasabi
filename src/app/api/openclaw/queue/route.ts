import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const { message, systemPrompt, section, chatHistory } = await req.json();
  if (!message) return NextResponse.json({ error: 'Missing message' }, { status: 400 });

  const { data, error } = await supabase
    .from('openclaw_messages')
    .insert({
      user_message: message,
      system_prompt: systemPrompt || null,
      section: section || 'Dashboard',
      chat_history: chatHistory ? JSON.stringify(chatHistory) : null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ id: data.id, status: 'pending' });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
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
