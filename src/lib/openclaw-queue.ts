import { supabase } from './supabase';

const POLL_INTERVAL = 1500;
const MAX_WAIT = 120_000; // 2 minutes

/**
 * Insert a message into the openclaw_messages queue and wait for
 * the VPS worker to process it. Returns the bot's response text.
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
  const { data, error } = await supabase
    .from('openclaw_messages')
    .insert({
      user_message: userMessage,
      system_prompt: opts.systemPrompt || null,
      section: opts.section || 'API',
      chat_history: opts.chatHistory ? JSON.stringify(opts.chatHistory) : null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Queue insert failed: ${error?.message ?? 'no data'}`);
  }

  const msgId = data.id;
  const deadline = Date.now() + (opts.timeoutMs ?? MAX_WAIT);

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);

    const { data: row, error: pollErr } = await supabase
      .from('openclaw_messages')
      .select('status, response, error_message')
      .eq('id', msgId)
      .single();

    if (pollErr) continue;

    if (row?.status === 'completed' && row.response) {
      return row.response;
    }

    if (row?.status === 'error') {
      throw new Error(row.error_message || 'OpenClaw processing error');
    }
  }

  throw new Error('OpenClaw response timeout');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
