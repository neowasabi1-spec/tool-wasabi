import { supabase } from './supabase';

/**
 * Queue a message for OpenClaw and poll until we get a response.
 * Uses Supabase-based queue — the worker on the VPS processes messages locally.
 */
export async function queueAndWait(
  userMessage: string,
  opts: {
    systemPrompt?: string;
    section?: string;
    chatHistory?: { role: string; content: string }[];
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const timeout = opts.timeoutMs ?? 120_000;
  const pollInterval = 3000;

  const { data: inserted, error: insertError } = await supabase
    .from('openclaw_messages')
    .insert({
      user_message: userMessage,
      system_prompt: opts.systemPrompt || null,
      section: opts.section || 'Internal',
      chat_history: opts.chatHistory ? JSON.stringify(opts.chatHistory) : null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    throw new Error(`Failed to queue OpenClaw message: ${insertError?.message || 'unknown error'}`);
  }

  const msgId = inserted.id;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, pollInterval));

    const { data: poll, error: pollError } = await supabase
      .from('openclaw_messages')
      .select('status, response, error_message')
      .eq('id', msgId)
      .single();

    if (pollError) {
      throw new Error(`Poll error: ${pollError.message}`);
    }

    if (poll?.status === 'completed') {
      if (!poll.response) throw new Error('OpenClaw returned empty response');
      return poll.response;
    }

    if (poll?.status === 'error') {
      throw new Error(`OpenClaw error: ${poll.error_message || 'unknown'}`);
    }
  }

  throw new Error(`OpenClaw timeout after ${timeout}ms`);
}
