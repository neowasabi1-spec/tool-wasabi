import { NextRequest, NextResponse } from 'next/server';

/**
 * Funnel Narrative Extractor
 * --------------------------
 * Riceve l'HTML di una pagina del funnel APPENA RISCRITTA da Claude e
 * ritorna uno structured summary che descrive l'angle / hook / big
 * promise / pain point / CTA / tono. Lo usa l'orchestratore "Swipe All"
 * per costruire il `funnel_context` da passare alle pagine successive
 * dello STESSO funnel, in modo che Claude mantenga coerenza narrativa.
 *
 * Output:
 *   {
 *     ok: true,
 *     summary: {
 *       headline: string,
 *       hook: string,
 *       bigPromise: string,
 *       primaryCta: string,
 *       angle: string,
 *       audience: string,
 *       keyPainPoint: string,
 *       uniqueMechanism: string,
 *       voice: string,
 *       oneLiner: string
 *     },
 *     blockText: string  // versione human-readable da concatenare al funnel_context
 *   }
 */

interface RequestBody {
  html?: string;
  pageName?: string;
  pageType?: string;
  stepIndex?: number;
  totalSteps?: number;
}

interface NarrativeSummary {
  headline: string;
  hook: string;
  bigPromise: string;
  primaryCta: string;
  angle: string;
  audience: string;
  keyPainPoint: string;
  uniqueMechanism: string;
  voice: string;
  oneLiner: string;
}

const SYSTEM_PROMPT = `You analyse a freshly rewritten funnel page and produce a tight, structured narrative summary so the next pages of the SAME funnel can stay consistent in voice, angle, promise, pain point and CTA logic.

Return ONLY a valid JSON object with these exact keys:
{
  "headline": "the main hero headline (verbatim if present, else paraphrase)",
  "hook": "the opening hook / big idea (1 sentence)",
  "bigPromise": "the core transformation promised (1 sentence)",
  "primaryCta": "the dominant CTA verb/phrase (e.g. 'Order Now', 'Get the Bundle')",
  "angle": "the single angle the page leans on (e.g. 'natural mechanism', 'doctor-formulated', 'before/after', 'limited stock', 'protocol-based')",
  "audience": "who the page speaks to (1 short phrase)",
  "keyPainPoint": "the dominant pain or problem the page hits (1 short phrase)",
  "uniqueMechanism": "the unique mechanism / differentiator named on the page (1 short phrase, or empty)",
  "voice": "tone of voice in 2-3 adjectives (e.g. 'authoritative, warm, urgent')",
  "oneLiner": "one ~150-char line a copywriter could read out loud to summarise the page"
}

No markdown, no code blocks, no commentary outside the JSON.`;

function stripHtmlForLlm(html: string): string {
  // Remove <script>, <style>, <svg> blocks fully (don't help summarising
  // copy and just inflate tokens). Then strip tags to get readable text.
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  // Collapse to readable text but keep heading markers so Claude knows
  // what was a headline vs body copy.
  const annotated = noScripts
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<button[^>]*>([\s\S]*?)<\/button>/gi, '\n[CTA] $1\n')
    .replace(/<a[^>]*class="[^"]*(?:cta|btn|button)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '\n[CTA] $1\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  return annotated.trim();
}

function clipForBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Keep the head (likely hero / opening) plus a small tail (likely CTA
  // section / footer) so the summary covers both ends of the page.
  const headChars = Math.floor(maxChars * 0.75);
  const tailChars = maxChars - headChars - 50;
  return `${text.slice(0, headChars)}\n\n[…clipped for budget…]\n\n${text.slice(-tailChars)}`;
}

function parseJson(raw: string): NarrativeSummary | null {
  let text = raw.trim();
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) text = codeBlock[1].trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  try {
    const o = JSON.parse(text) as Partial<NarrativeSummary>;
    if (!o || typeof o !== 'object') return null;
    return {
      headline: typeof o.headline === 'string' ? o.headline : '',
      hook: typeof o.hook === 'string' ? o.hook : '',
      bigPromise: typeof o.bigPromise === 'string' ? o.bigPromise : '',
      primaryCta: typeof o.primaryCta === 'string' ? o.primaryCta : '',
      angle: typeof o.angle === 'string' ? o.angle : '',
      audience: typeof o.audience === 'string' ? o.audience : '',
      keyPainPoint: typeof o.keyPainPoint === 'string' ? o.keyPainPoint : '',
      uniqueMechanism:
        typeof o.uniqueMechanism === 'string' ? o.uniqueMechanism : '',
      voice: typeof o.voice === 'string' ? o.voice : '',
      oneLiner: typeof o.oneLiner === 'string' ? o.oneLiner : '',
    };
  } catch {
    return null;
  }
}

function summaryToBlock(
  s: NarrativeSummary,
  pageName: string,
  pageType: string,
  stepIndex: number,
  totalSteps: number,
): string {
  const headerBits: string[] = [];
  if (stepIndex && totalSteps) headerBits.push(`step ${stepIndex}/${totalSteps}`);
  if (pageType) headerBits.push(pageType);
  if (pageName) headerBits.push(pageName);
  const header = headerBits.join(' · ') || 'page';

  const lines: string[] = [];
  lines.push(`▸ ${header}`);
  if (s.headline) lines.push(`  - Headline: ${s.headline}`);
  if (s.hook) lines.push(`  - Hook: ${s.hook}`);
  if (s.bigPromise) lines.push(`  - Big promise: ${s.bigPromise}`);
  if (s.angle) lines.push(`  - Angle: ${s.angle}`);
  if (s.uniqueMechanism) lines.push(`  - Unique mechanism: ${s.uniqueMechanism}`);
  if (s.audience) lines.push(`  - Audience: ${s.audience}`);
  if (s.keyPainPoint) lines.push(`  - Key pain: ${s.keyPainPoint}`);
  if (s.primaryCta) lines.push(`  - Primary CTA: ${s.primaryCta}`);
  if (s.voice) lines.push(`  - Voice: ${s.voice}`);
  if (s.oneLiner) lines.push(`  - One-liner: ${s.oneLiner}`);
  return lines.join('\n');
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'ANTHROPIC_API_KEY mancante. Aggiungila nelle env var del deploy e riprova.',
      },
      { status: 500 },
    );
  }

  const html = (body.html || '').trim();
  if (!html || html.length < 200) {
    return NextResponse.json(
      { ok: false, error: 'HTML mancante o troppo corto per estrarre narrative' },
      { status: 400 },
    );
  }

  const pageName = (body.pageName || '').trim();
  const pageType = (body.pageType || '').trim();
  const stepIndex = Number(body.stepIndex || 0);
  const totalSteps = Number(body.totalSteps || 0);

  const text = clipForBudget(stripHtmlForLlm(html), 18_000);

  const userText = [
    `Page: ${pageName || 'unknown'}${pageType ? ` (${pageType})` : ''}${
      stepIndex && totalSteps ? ` — step ${stepIndex}/${totalSteps}` : ''
    }`,
    '---',
    'Plain-text body of the freshly rewritten page (with [CTA] / # / ## markers preserved):',
    text,
    '---',
    'Return the JSON described in the system instructions.',
  ].join('\n');

  let claudeText = '';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userText }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return NextResponse.json(
        {
          ok: false,
          error: `Claude API ${resp.status}: ${errText.slice(0, 300)}`,
        },
        { status: 502 },
      );
    }
    const data = (await resp.json()) as {
      content?: { type: string; text?: string }[];
    };
    claudeText = data.content?.find((c) => c.type === 'text')?.text ?? '';
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? `Claude request failed: ${err.message}`
            : 'Claude request failed',
      },
      { status: 502 },
    );
  }

  const summary = parseJson(claudeText);
  if (!summary) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Claude non ha restituito un JSON valido',
        raw: claudeText.slice(0, 600),
      },
      { status: 502 },
    );
  }

  const blockText = summaryToBlock(summary, pageName, pageType, stepIndex, totalSteps);

  return NextResponse.json({
    ok: true,
    summary,
    blockText,
  });
}
