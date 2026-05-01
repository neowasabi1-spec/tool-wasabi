import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * GET /api/funnel-analyzer/save-steps/check
 * Verify that Supabase is configured and the funnel_crawl_steps table exists.
 * Useful on Fly.dev to diagnose save errors.
 */
export async function GET() {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      return NextResponse.json({
        ok: false,
        error: 'Variabili Supabase mancanti',
        hasUrl: !!url,
        hasKey: !!key,
      });
    }
    const { data, error } = await supabase
      .from('funnel_crawl_steps')
      .select('id')
      .limit(1);
    if (error) {
      return NextResponse.json({
        ok: false,
        error: error.message,
        code: error.code,
        details: error.details,
      });
    }
    return NextResponse.json({
      ok: true,
      tableExists: true,
      message: 'Supabase configured and funnel_crawl_steps table accessible',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg });
  }
}
