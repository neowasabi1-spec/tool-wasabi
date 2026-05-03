import { NextRequest, NextResponse } from 'next/server';
import { requireAnthropicKey } from '@/lib/anthropic-key';

export const maxDuration = 26;
export const dynamic = 'force-dynamic';

interface BatchItem {
  id: number;
  text: string;
  tag: string;
}

function cleanAiOutput(text: string): string {
  let cleaned = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const a = cleaned.indexOf('[');
  const b = cleaned.lastIndexOf(']');
  if (a >= 0 && b > a) cleaned = cleaned.substring(a, b + 1);
  return cleaned.trim();
}

async function callAnthropic(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = requireAnthropicKey();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(22_000),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errBody.substring(0, 300)}`);
  }
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text || '';
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      batch: BatchItem[];
      systemPrompt: string;
      label?: string;
      strict?: boolean;
    };
    const { batch, systemPrompt, label, strict } = body;

    if (!Array.isArray(batch) || batch.length === 0) {
      return NextResponse.json({ error: 'batch (non-empty array) required' }, { status: 400 });
    }
    if (!systemPrompt || typeof systemPrompt !== 'string') {
      return NextResponse.json({ error: 'systemPrompt required' }, { status: 400 });
    }
    if (batch.length > 60) {
      return NextResponse.json({ error: 'batch too large (max 60)' }, { status: 400 });
    }

    const labelText = label || 'Batch';
    const strictNote = strict
      ? `\nQuesto e un GAP-FILL: gli id qui sotto sono stati saltati o tornati invariati in un giro precedente. NON tornare l'originale identico. Adatta sempre al prodotto target usando il brief.`
      : '';
    const userPrompt = `${labelText}: produci ESATTAMENTE una voce JSON {"id","rewritten"} per ognuno dei ${batch.length} id qui sotto. Mai saltare un id, mai restituire l'originale identico (eccezione: copy legale/compliance).${strictNote}

${JSON.stringify(batch, null, 2)}

Output: SOLO un JSON array nella forma [{"id": 0, "rewritten": "..."}, ...]. Niente preambolo, niente spiegazioni, niente markdown fences.`;

    let aiText: string;
    try {
      aiText = await callAnthropic(systemPrompt, userPrompt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[quiz-rewrite/batch] Anthropic call failed:', msg);
      return NextResponse.json({ error: `Anthropic: ${msg}` }, { status: 502 });
    }

    if (!aiText.trim()) {
      return NextResponse.json({ error: 'Empty Anthropic response' }, { status: 502 });
    }

    let rewrites: Array<{ id: number; rewritten: string }>;
    try {
      const cleaned = cleanAiOutput(aiText);
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
      rewrites = parsed.filter(
        (r: unknown): r is { id: number; rewritten: string } =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as { id?: unknown }).id === 'number' &&
          typeof (r as { rewritten?: unknown }).rewritten === 'string',
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[quiz-rewrite/batch] JSON parse failed:', msg, 'raw=', aiText.substring(0, 200));
      return NextResponse.json({ error: `Parse error: ${msg}` }, { status: 502 });
    }

    return NextResponse.json({
      rewrites,
      receivedIds: batch.map((b) => b.id),
      returnedCount: rewrites.length,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[quiz-rewrite/batch] Error:', errMsg);
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
