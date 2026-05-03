import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 26;
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

interface JobRow {
  id: string;
  status: string;
  chat_history: {
    html: string;
    texts: Array<{ original: string; tag: string }>;
    productName: string;
    totalTextsInPage: number;
  } | string | null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Entity-aware regex: cerca il testo nell'HTML accettando varianti come &amp;
// per & oppure &#39;/&apos; per ', dato che universal-text-extractor decodifica
// queste entities ma l'HTML originale puo contenere ancora la forma codificata.
// Inoltre rende il whitespace tollerante: un singolo spazio nel testo estratto
// puo corrispondere a piu spazi, newline, &nbsp; o tag inline (<br>, <span>) nell'HTML.
function buildTolerantPattern(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part)) {
        return '(?:\\s|&nbsp;|&#160;|<br\\s*\\/?\\s*>|<\\/?(?:span|b|i|em|strong|u|small|font)\\b[^>]*>)+';
      }
      let escaped = escapeRegex(part);
      escaped = escaped.replace(/&/g, '(?:&|&amp;)');
      escaped = escaped.replace(/'/g, "(?:'|&#39;|&apos;|\\u2019)");
      escaped = escaped.replace(/"/g, '(?:"|&quot;|&#34;)');
      escaped = escaped.replace(/</g, '(?:<|&lt;)');
      escaped = escaped.replace(/>/g, '(?:>|&gt;)');
      return escaped;
    })
    .join('');
}

function htmlEncode(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyRewrites(
  html: string,
  texts: Array<{ original: string; tag: string }>,
  rewrites: Array<{ id: number; rewritten: string }>,
): { html: string; replacements: number } {
  let resultHtml = html;
  let replacements = 0;
  let exactHits = 0;
  let tolerantHits = 0;
  let misses = 0;

  for (const rw of rewrites) {
    const original = texts[rw.id];
    if (!original || !rw.rewritten) continue;
    const trimmed = rw.rewritten.trim();
    if (!trimmed || original.original === trimmed) continue;

    const o = original.original;
    const before = resultHtml;

    // 1) Match esatto su stringa (rapido, copre la maggior parte dei casi)
    if (resultHtml.includes(o)) {
      const re = new RegExp(escapeRegex(o), 'g');
      resultHtml = resultHtml.replace(re, trimmed);
      if (resultHtml !== before) {
        exactHits++;
        replacements++;
        continue;
      }
    }

    // 2) Match tollerante: entity-aware + whitespace flessibile.
    //    Risolve casi tipo &amp;/&#39; e spazi multipli/<br>/<span> in mezzo.
    try {
      const tolerantPattern = buildTolerantPattern(o);
      const reTol = new RegExp(tolerantPattern, 'gi');
      const beforeTol = resultHtml;
      resultHtml = resultHtml.replace(reTol, () => htmlEncode(trimmed));
      if (resultHtml !== beforeTol) {
        tolerantHits++;
        replacements++;
        continue;
      }
    } catch {
      // pattern troppo complesso, ignora
    }

    misses++;
  }

  console.log(
    `[quiz-rewrite/finalize] applied: exact=${exactHits} tolerant=${tolerantHits} miss=${misses} of ${rewrites.length}`,
  );

  return { html: resultHtml, replacements };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      jobId: string;
      rewrites: Array<{ id: number; rewritten: string }>;
      unresolvedIds?: number[];
    };
    const { jobId, rewrites, unresolvedIds } = body;

    if (!jobId) {
      return NextResponse.json({ error: 'jobId required' }, { status: 400 });
    }
    if (!Array.isArray(rewrites)) {
      return NextResponse.json({ error: 'rewrites array required' }, { status: 400 });
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/openclaw_messages?id=eq.${encodeURIComponent(jobId)}&select=id,status,chat_history`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      },
    );

    if (!fetchRes.ok) {
      const errText = await fetchRes.text();
      return NextResponse.json({ error: `Supabase fetch error: ${errText.substring(0, 200)}` }, { status: 500 });
    }

    const rows = (await fetchRes.json()) as JobRow[];
    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const job = rows[0];
    let chatHistory = job.chat_history;
    if (typeof chatHistory === 'string') {
      try {
        chatHistory = JSON.parse(chatHistory);
      } catch {
        return NextResponse.json({ error: 'Failed to parse chat_history' }, { status: 500 });
      }
    }
    if (!chatHistory || typeof chatHistory === 'string' || !chatHistory.html || !chatHistory.texts) {
      return NextResponse.json({ error: 'Original HTML/texts not found in job' }, { status: 500 });
    }

    const dedup = new Map<number, string>();
    for (const rw of rewrites) {
      if (typeof rw.id === 'number' && typeof rw.rewritten === 'string') {
        dedup.set(rw.id, rw.rewritten);
      }
    }
    const cleanRewrites = Array.from(dedup, ([id, rewritten]) => ({ id, rewritten }));

    const { html: rewrittenHtml, replacements } = applyRewrites(
      chatHistory.html,
      chatHistory.texts,
      cleanRewrites,
    );

    const responseJson = JSON.stringify(cleanRewrites);
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/openclaw_messages?id=eq.${encodeURIComponent(jobId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          status: 'completed',
          response: responseJson,
          completed_at: new Date().toISOString(),
        }),
      },
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('[quiz-rewrite/finalize] Supabase update failed:', errText);
    }

    console.log(
      `[quiz-rewrite/finalize] job=${jobId} rewrites=${cleanRewrites.length} replacements=${replacements} unresolved=${unresolvedIds?.length || 0}`,
    );

    return NextResponse.json({
      status: 'completed',
      result: {
        html: rewrittenHtml,
        replacements,
        totalTexts: chatHistory.texts.length,
        totalTextsInPage: chatHistory.totalTextsInPage,
        originalLength: chatHistory.html.length,
        newLength: rewrittenHtml.length,
        provider: 'anthropic-chunked',
        unresolvedIds: unresolvedIds || [],
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[quiz-rewrite/finalize] Error:', errMsg);
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
