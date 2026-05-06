import { NextRequest, NextResponse } from 'next/server';
import { getCoreKnowledge } from '@/knowledge/copywriting';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const EDGE_FUNCTION_NAME = 'funnel-swap-v1-functions';

// Knowledge base loaded lazily and memoised at module level. ~28K tokens
// always-on copywriting frameworks (COS Engine, Tony Flores, Evaldo,
// Anghelache, Savage System, 108 split tests). Sent as a cached system block
// so the cost is paid once per ~5 min across all batches of the same job.
let _kbCache: string | null = null;
function getKb(): string {
  if (_kbCache === null) {
    try {
      _kbCache = getCoreKnowledge();
    } catch (err) {
      console.warn('[funnel-swap-proxy] knowledge base load failed:', err);
      _kbCache = '';
    }
  }
  return _kbCache;
}

/**
 * Thin proxy that forwards the incoming JSON body to the Supabase Edge
 * Function `funnel-swap-v1-functions` and injects, server-side:
 *   - `system_kb`      : copywriting knowledge base (cached system block)
 *   - `brief`          : optional project brief (passed-through)
 *   - `market_research`: optional market research notes (passed-through)
 *
 * The browser never sees the KB content; only the Next.js server reads it
 * from disk (src/knowledge/copywriting/raw/*.md) and forwards it to Supabase.
 */
export async function POST(request: NextRequest) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return NextResponse.json(
      { error: 'Supabase non configurato. Imposta NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local' },
      { status: 500 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch (jsonErr) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${jsonErr instanceof Error ? jsonErr.message : 'parse error'}` },
      { status: 400 },
    );
  }

  // Only inject the KB when the call will hit Claude. The extract phase is
  // pure HTML scraping (no Claude call) so adding the KB would just bloat
  // the request payload.
  const phase = (body.phase as string) || '';
  const cloneMode = (body.cloneMode as string) || '';
  const willCallClaude =
    (phase === 'process' && cloneMode === 'rewrite') ||
    cloneMode === 'translate';

  const enrichedBody: Record<string, unknown> = { ...body };

  if (willCallClaude && !enrichedBody.system_kb) {
    const kb = getKb();
    if (kb) enrichedBody.system_kb = kb;
  }

  const edgeFunctionUrl = `${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION_NAME}`;

  const t0 = Date.now();
  let response: Response;
  try {
    response = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(enrichedBody),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[funnel-swap-proxy] fetch failed:', msg);
    return NextResponse.json(
      { error: `Edge function unreachable: ${msg}` },
      { status: 502 },
    );
  }

  const elapsedMs = Date.now() - t0;
  const kbInjected = !!enrichedBody.system_kb;
  console.log(
    `[funnel-swap-proxy] phase=${phase || '?'} cloneMode=${cloneMode || '?'} ` +
    `kb=${kbInjected ? 'yes' : 'no'} status=${response.status} time=${elapsedMs}ms`,
  );

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    return NextResponse.json(
      { error: `Edge function error (${response.status}): ${text.substring(0, 500)}` },
      { status: response.status },
    );
  }

  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
