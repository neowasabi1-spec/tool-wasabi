import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/checkpoint/runs/[runId]/queue-status
 *
 * For OpenClaw audits we enqueue a row in `openclaw_messages` and
 * return immediately. The dashboard needs a way to tell the user:
 *   - "in coda, in attesa che Neo/Morfeo se lo prenda"
 *   - "worker sta processando"
 *   - "worker ha completato (ora i risultati arriveranno via openclaw-finalize)"
 *   - "worker ha dato errore: X"
 *
 * The runId is embedded inside the message's user_message JSON
 * payload, so we filter with ILIKE on `"runId":"<id>"`. Volume here
 * is small (one row per audit), so the LIKE scan is fine.
 *
 * Returns:
 *   { found: false }
 *   { found: true, status, target_agent, created_at, updated_at,
 *     error_message, age_seconds }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { runId: string } | Promise<{ runId: string }> },
) {
  const { runId } = params instanceof Promise ? await params : params;
  if (!runId) {
    return NextResponse.json({ error: 'Missing runId' }, { status: 400 });
  }

  // Filter on the JSON-as-text. We're looking for the EXACT runId
  // substring, escaped enough to avoid false positives from other
  // funnels.
  const needle = `"runId":"${runId.replace(/[%_]/g, '')}"`;

  const { data, error } = await supabase
    .from('openclaw_messages')
    .select(
      'id, status, target_agent, created_at, updated_at, error_message',
    )
    .eq('section', 'checkpoint_audit')
    .ilike('user_message', `%${needle}%`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 },
    );
  }

  if (!data) {
    return NextResponse.json({ found: false });
  }

  const ageSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(data.created_at).getTime()) / 1000),
  );

  return NextResponse.json({
    found: true,
    status: data.status as
      | 'pending'
      | 'processing'
      | 'completed'
      | 'error',
    target_agent: data.target_agent,
    created_at: data.created_at,
    updated_at: data.updated_at,
    error_message: data.error_message,
    age_seconds: ageSeconds,
  });
}
