import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Returns the original→rewritten text mapping for a completed cloning job.
 * Used by quiz pages to build a runtime text patcher instead of static HTML replacement.
 */
export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json({ error: 'jobId required' }, { status: 400 });
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const { data: texts, error } = await supabase
      .from('cloning_texts')
      .select('original_text, rewritten_text')
      .eq('job_id', jobId)
      .eq('processed', true)
      .not('rewritten_text', 'is', null);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const mappings: Record<string, string> = {};
    for (const t of texts || []) {
      if (t.original_text && t.rewritten_text && t.original_text !== t.rewritten_text) {
        mappings[t.original_text] = t.rewritten_text;
      }
    }

    return NextResponse.json({ success: true, mappings, count: Object.keys(mappings).length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
