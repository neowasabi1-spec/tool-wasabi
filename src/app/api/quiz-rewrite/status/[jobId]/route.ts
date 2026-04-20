import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

interface JobRow {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'error';
  response: string | null;
  error_message: string | null;
  chat_history: {
    html: string;
    texts: Array<{ original: string; tag: string }>;
    productName: string;
    totalTextsInPage: number;
  } | null;
}

function applyRewrites(
  html: string,
  texts: Array<{ original: string; tag: string }>,
  rewrites: Array<{ id: number; rewritten: string }>
): { html: string; replacements: number } {
  let resultHtml = html;
  let replacements = 0;

  for (const rw of rewrites) {
    const original = texts[rw.id];
    if (!original || !rw.rewritten || original.original === rw.rewritten) continue;
    const escaped = original.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const before = resultHtml;
    resultHtml = resultHtml.replace(new RegExp(escaped, 'g'), rw.rewritten);
    if (resultHtml !== before) replacements++;
  }

  return { html: resultHtml, replacements };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  if (!jobId) {
    return NextResponse.json({ error: 'jobId required' }, { status: 400 });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/openclaw_messages?id=eq.${encodeURIComponent(jobId)}&select=id,status,response,error_message,chat_history`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ error: `Supabase error: ${errText.substring(0, 200)}` }, { status: 500 });
    }

    const rows = await res.json() as JobRow[];
    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const job = rows[0];

    if (job.status === 'pending' || job.status === 'processing') {
      return NextResponse.json({ status: job.status });
    }

    if (job.status === 'error') {
      return NextResponse.json({
        status: 'error',
        error: job.error_message || 'Unknown error during rewrite',
      });
    }

    // status === 'completed'
    if (!job.response) {
      return NextResponse.json({ status: 'error', error: 'Job completed but no response found' });
    }

    // Parse rewrites from response
    let rewrites: Array<{ id: number; rewritten: string }> = [];
    try {
      let cleaned = job.response.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      const startIdx = cleaned.indexOf('[');
      const endIdx = cleaned.lastIndexOf(']');
      if (startIdx >= 0 && endIdx > startIdx) cleaned = cleaned.substring(startIdx, endIdx + 1);
      rewrites = JSON.parse(cleaned);
    } catch {
      return NextResponse.json({ status: 'error', error: 'Failed to parse rewrite response JSON' });
    }

    // Get original HTML and texts from chat_history
    const chatHistory = job.chat_history;
    if (!chatHistory?.html || !chatHistory?.texts) {
      return NextResponse.json({ status: 'error', error: 'Original HTML not found in job data' });
    }

    // Apply rewrites to original HTML
    const { html: rewrittenHtml, replacements } = applyRewrites(chatHistory.html, chatHistory.texts, rewrites);

    return NextResponse.json({
      status: 'completed',
      result: {
        html: rewrittenHtml,
        replacements,
        totalTexts: chatHistory.texts.length,
        totalTextsInPage: chatHistory.totalTextsInPage,
        originalLength: chatHistory.html.length,
        newLength: rewrittenHtml.length,
        provider: 'openclaw-async',
      },
    });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[quiz-rewrite/status] Error:', errMsg);
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
