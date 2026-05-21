import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * POST /api/swipe/emergency-stop
 *
 * Big red button per fermare TUTTO il lavoro swipe in corso quando il
 * sistema sta thrasshing (es. MCP backend irraggiungibile, worker locale
 * impazzito, retry loop senza fine). NON tocca processi locali Node —
 * solo lo stato in Supabase, cosi' i worker che stanno processando un job
 * vedono lo stato = error e smettono di toccarlo.
 *
 * Cosa fa:
 *  1. openclaw_messages: tutti i pending/processing -> error
 *  2. funnel_crawl_jobs: tutti i pending/running -> error
 *  3. funnel_pages: swipe_status = in_progress|pending -> idle (libera la UI)
 *
 * Idempotente: chiamarlo 2 volte non fa danno.
 */
export async function POST() {
  const startedAt = Date.now();
  const summary = {
    openclawMessagesKilled: 0,
    funnelCrawlJobsKilled: 0,
    funnelPagesReset: 0,
    errors: [] as string[],
  };

  // 1) openclaw_messages: pending|processing -> error
  try {
    const { data, error } = await supabase
      .from('openclaw_messages')
      .update({
        status: 'error',
        error_message: 'Stopped via emergency-stop button',
        completed_at: new Date().toISOString(),
      })
      .in('status', ['pending', 'processing'])
      .select('id');
    if (error) summary.errors.push(`openclaw_messages: ${error.message}`);
    else summary.openclawMessagesKilled = data?.length ?? 0;
  } catch (err) {
    summary.errors.push(
      `openclaw_messages: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }

  // 2) funnel_crawl_jobs: pending|running -> failed
  // NB: this table has a CHECK constraint on status; it accepts 'failed'
  // (not 'error' like openclaw_messages does). Discovered the hard way.
  try {
    const { data, error } = await supabase
      .from('funnel_crawl_jobs')
      .update({
        status: 'failed',
        error: 'Stopped via emergency-stop button',
        updated_at: new Date().toISOString(),
      })
      .in('status', ['pending', 'running'])
      .select('id');
    if (error) summary.errors.push(`funnel_crawl_jobs: ${error.message}`);
    else summary.funnelCrawlJobsKilled = data?.length ?? 0;
  } catch (err) {
    summary.errors.push(
      `funnel_crawl_jobs: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }

  // 3) funnel_pages: in_progress|pending -> idle (sblocca la UI)
  try {
    const { data, error } = await supabase
      .from('funnel_pages')
      .update({ swipe_status: 'idle' })
      .in('swipe_status', ['in_progress', 'pending'])
      .select('id');
    if (error) summary.errors.push(`funnel_pages: ${error.message}`);
    else summary.funnelPagesReset = data?.length ?? 0;
  } catch (err) {
    summary.errors.push(
      `funnel_pages: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }

  const totalKilled =
    summary.openclawMessagesKilled +
    summary.funnelCrawlJobsKilled +
    summary.funnelPagesReset;

  return NextResponse.json({
    ok: summary.errors.length === 0,
    durationMs: Date.now() - startedAt,
    totalKilled,
    ...summary,
  });
}

export async function GET() {
  return NextResponse.json(
    {
      info: 'Emergency-stop endpoint. POST to invoke. Marks all pending/processing swipe + crawl jobs as error and resets in-progress funnel_pages to idle.',
    },
    { status: 200 },
  );
}
