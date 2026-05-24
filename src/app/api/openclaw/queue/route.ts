import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const { message, systemPrompt, section, chatHistory, targetAgent } =
    await req.json();
  if (!message) return NextResponse.json({ error: 'Missing message' }, { status: 400 });

  // `X-Wasabi-Angle` (optional, URL-encoded): per-row marketing angle
  // for swipe jobs. Sent as an HTTP HEADER (not body) so it does not
  // count against Netlify Functions' 6MB body limit — the brief is
  // already duplicated 3x in the swipe payload and big projects get
  // close to the cap, so any extra body byte triggered 500 Internal
  // Error. We decode and inject it into the stored user_message JSON
  // here, where there is no size limit. Workers read `payload.angle`
  // exactly as if it had been in the body.
  let messageToStore: unknown = message;
  const angleHeader = req.headers.get('x-wasabi-angle');
  if (angleHeader && typeof message === 'string') {
    try {
      const decoded = decodeURIComponent(angleHeader).slice(0, 2000);
      if (decoded.trim()) {
        const parsed = JSON.parse(message);
        if (parsed && typeof parsed === 'object') {
          parsed.angle = decoded.trim();
          messageToStore = JSON.stringify(parsed);
        }
      }
    } catch {
      // Header decode or JSON parse failed — fall back to original
      // message untouched so the job still enqueues. The worker will
      // simply not see an angle directive (graceful degradation).
    }
  }

  // `targetAgent` (e.g. "openclaw:neo", "openclaw:morfeo") routes the
  // job to a specific worker. Without it, ANY worker can claim the
  // row (legacy first-come-first-served behaviour). Used by the
  // clone-landing / agentic-swipe / checkpoint UIs to honor an
  // explicit auditor selection without changing the worker poll
  // logic — workers already filter by `target_agent.is.null OR
  // target_agent.eq.<their-agent>`.
  const insert: Record<string, unknown> = {
    user_message: messageToStore,
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

/**
 * DELETE /api/openclaw/queue?id=<row-id>&reason=<short-text>
 *
 * Cancel a SINGLE in-flight openclaw_messages row. Used by the UI
 * watchdogs (no-pickup 90s, page-timeout 60min, manual Swipe All
 * cancel) so when the client gives up on a job it ALSO instructs the
 * queue to discard it instead of leaving it `pending` forever — which
 * was the old behavior and caused the worker to eventually pick it up
 * and burn LLM tokens on a result the user never sees.
 *
 * Idempotent. Only flips rows that are still pending/processing —
 * already completed/error rows are left alone so we don't lose history.
 *
 * Pairs with the cooperative-abort poller in openclaw-worker.js: if
 * the job was already 'processing', the worker will detect the status
 * flip within ~5s and abort cleanly without further LLM calls.
 */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  const reason = (req.nextUrl.searchParams.get('reason') || 'cancelled by client').slice(0, 200);
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { data, error } = await supabase
    .from('openclaw_messages')
    .update({
      status: 'error',
      error_message: reason,
      completed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['pending', 'processing'])
    .select('id, status');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    cancelled: (data?.length ?? 0) > 0,
    id,
    reason,
  });
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
    .select('status, response, error_message, target_agent, created_at')
    .eq('id', id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Watchdog helper: when a job stays 'pending' troppo a lungo,
  // il client UI non sa se "il worker e' down" o "il worker e' occupato
  // con un altro job lungo (5-20 min) e non puo' fare claim". Restituiamo
  // info su altri job in 'processing' per lo stesso target_agent: cosi' la
  // UI puo' distinguere "worker offline" da "worker busy" e dare messaggi
  // azionabili invece di "verifica che il worker giri" ingiustamente.
  let workerBusyWith: { id: string; section: string | null; started_at: string | null } | null = null;
  if (data.status === 'pending') {
    let q = supabase
      .from('openclaw_messages')
      .select('id, section, created_at')
      .eq('status', 'processing')
      .neq('id', id)
      .order('created_at', { ascending: true })
      .limit(1);
    if (data.target_agent) q = q.eq('target_agent', data.target_agent);
    const { data: busy } = await q;
    if (busy && busy.length > 0) {
      workerBusyWith = {
        id: busy[0].id,
        section: busy[0].section,
        started_at: busy[0].created_at,
      };
    }
  }

  return NextResponse.json({
    status: data.status,
    content: data.response,
    // `response` e' un alias di `content` usato dalla reidratazione HTML
    // (useStore.loadAllData / Eye-button fetch on-demand). Mantengo
    // entrambi per non rompere altri client (clone-landing, strategist,
    // front-end-funnel poll) che leggono `content`.
    response: data.response,
    error: data.error_message,
    target_agent: data.target_agent || null,
    worker_busy_with: workerBusyWith,
  });
}
