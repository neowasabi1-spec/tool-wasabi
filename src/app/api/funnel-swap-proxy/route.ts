import { NextRequest, NextResponse } from 'next/server';
import { getKnowledgeBundleForTask } from '@/knowledge/copywriting';
import {
  buildRoutedSectionContent,
  pageTypeToTask,
  type CopywritingTask,
} from '@/lib/section-routing';
import type { SectionFile } from '@/lib/project-sections';
import { isSpaShell, rescueViaJina } from '@/lib/spa-rescue';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const EDGE_FUNCTION_NAME = 'funnel-swap-v1-functions';

// Hard char cap per section sent to Claude. Mirrors SECTION_CHAR_LIMIT in
// the Edge Function so we never overflow once we add KB + system overhead.
const SECTION_CHAR_BUDGET = 200_000;

// Knowledge base bundles, memoised per task. Tier 1 (~28K tok) is shared by
// every task (loaded once); Tier 2 differs per task and is selected from
// SOURCES via priority + budget. Anthropic Prompt Caching makes the bundle
// cost ~10% on hits within ~5 min, so per-task caches are still cheap.
const _kbCache = new Map<CopywritingTask, string>();
function getKbForTask(task: CopywritingTask): string {
  const cached = _kbCache.get(task);
  if (cached !== undefined) return cached;
  let kb = '';
  try {
    kb = getKnowledgeBundleForTask(task);
    const approxTokens = Math.round(kb.length / 4);
    console.log(
      `[funnel-swap-proxy] KB loaded for task=${task}: ${kb.length} chars / ~${approxTokens} tokens`,
    );
  } catch (err) {
    console.warn(`[funnel-swap-proxy] KB load failed for task=${task}:`, err);
  }
  _kbCache.set(task, kb);
  return kb;
}

interface RoutingPayload {
  files?: SectionFile[];
  notes?: string;
}

function asFiles(val: unknown): SectionFile[] {
  if (!Array.isArray(val)) return [];
  return val.filter(
    (f): f is SectionFile =>
      !!f && typeof f === 'object' && typeof (f as SectionFile).name === 'string' &&
      typeof (f as SectionFile).content === 'string',
  );
}

/**
 * Thin proxy that forwards the incoming JSON body to the Supabase Edge
 * Function `funnel-swap-v1-functions`. The proxy is responsible for the
 * server-side intelligence layer:
 *
 *   1. Loads and injects the copywriting Knowledge Base (`system_kb`)
 *      sized for the current pageType (Tier 1 always + Tier 2 task add-ons).
 *   2. Routes the project's Brief and Market Research files based on the
 *      pageType being rewritten — only relevant docs reach Claude.
 *   3. Caps every section to SECTION_CHAR_BUDGET so we never overflow the
 *      Edge Function input limits.
 *
 * Body fields read (all optional):
 *   - pageType            : string  — drives KB Tier 2 + file routing
 *   - brief_files         : SectionFile[]
 *   - brief_notes         : string
 *   - research_files      : SectionFile[]
 *   - research_notes      : string
 *   - brief               : string  — legacy fallback (no routing)
 *   - market_research     : string  — legacy fallback (no routing)
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

  // Only inject KB / route files when we'll actually call Claude. The extract
  // phase is pure HTML scraping (no Claude) so adding the KB would just bloat
  // the request payload.
  const phase = (body.phase as string) || '';
  const cloneMode = (body.cloneMode as string) || '';
  const willCallClaude =
    (phase === 'process' && cloneMode === 'rewrite') ||
    cloneMode === 'translate';

  const enrichedBody: Record<string, unknown> = { ...body };
  // Strip the routing-only fields before forwarding so they don't leak into
  // the Edge Function payload (it doesn't read them).
  delete enrichedBody.brief_files;
  delete enrichedBody.brief_notes;
  delete enrichedBody.research_files;
  delete enrichedBody.research_notes;

  // ─── SPA rescue (defence in depth) ────────────────────────────────────────
  // The Edge Function expects `renderedHtml` to be the JS-rendered page
  // payload (so it can extract texts to rewrite). On Netlify the upstream
  // /api/clone-funnel call already tries Jina when the chrome/googlebot
  // attempts return an SPA shell — but if anything went wrong (cached
  // shell HTML on the page object, direct call without prior cloning,
  // legacy clients) `renderedHtml` may still be missing or look like a
  // shell. We rescue it here via Jina markdown→HTML so the Edge Function
  // never sees an empty SPA. Only runs on the 'extract' phase to avoid
  // double-work on the per-batch 'process' calls.
  if (phase === 'extract' && (cloneMode === 'rewrite' || cloneMode === 'translate')) {
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const renderedHtmlRaw = body.renderedHtml;
    const renderedHtml = typeof renderedHtmlRaw === 'string' ? renderedHtmlRaw : '';
    const needsRescue =
      url && (!renderedHtml || isSpaShell(renderedHtml));
    if (needsRescue) {
      const reason = !renderedHtml
        ? 'missing'
        : `looks like SPA shell (${renderedHtml.length} chars, body text < 200)`;
      console.warn(
        `[funnel-swap-proxy] renderedHtml ${reason} for ${url} — rescuing via Jina before extract`,
      );
      const t = Date.now();
      const rescued = await rescueViaJina(url);
      const ms = Date.now() - t;
      if (rescued && rescued.length > 1000) {
        enrichedBody.renderedHtml = rescued;
        console.log(
          `[funnel-swap-proxy] Jina rescued ${rescued.length} chars in ${ms}ms — forwarding to Edge Function`,
        );
      } else {
        console.error(
          `[funnel-swap-proxy] Jina rescue FAILED in ${ms}ms — Edge Function will likely return "No text found"`,
        );
        // Keep the original (broken) renderedHtml so the Edge Function returns
        // its informative error message rather than us synthesising one.
      }
    }
  }

  if (willCallClaude) {
    const pageType = (body.pageType as string) || 'pdp';
    const task = pageTypeToTask(pageType);

    // 1) Knowledge base sized for the current pageType (cached per task).
    if (!enrichedBody.system_kb) {
      const kb = getKbForTask(task);
      if (kb) enrichedBody.system_kb = kb;
    }

    // 2) Brief routing (when the client sent a structured payload).
    const briefPayload: RoutingPayload = {
      files: asFiles((body as { brief_files?: unknown }).brief_files),
      notes: typeof body.brief_notes === 'string' ? body.brief_notes : '',
    };
    if (briefPayload.files && briefPayload.files.length > 0) {
      const { content, selection } = buildRoutedSectionContent(
        briefPayload.files,
        briefPayload.notes ?? '',
        pageType,
        SECTION_CHAR_BUDGET,
      );
      enrichedBody.brief = content;
      console.log(
        `[funnel-swap-proxy] brief routing pageType=${pageType} task=${task} ` +
        `selected=${selection.selected.length}/${briefPayload.files.length} ` +
        `chars=${selection.totalChars}/${selection.budgetChars} ` +
        `kept=[${selection.selected.map((f) => f.name).join(', ')}] ` +
        `skipped=[${selection.skipped.map((s) => `${s.file.name}(${s.reason})`).join(', ')}]`,
      );
    }

    // 3) Market research routing.
    const researchPayload: RoutingPayload = {
      files: asFiles((body as { research_files?: unknown }).research_files),
      notes: typeof body.research_notes === 'string' ? body.research_notes : '',
    };
    if (researchPayload.files && researchPayload.files.length > 0) {
      const { content, selection } = buildRoutedSectionContent(
        researchPayload.files,
        researchPayload.notes ?? '',
        pageType,
        SECTION_CHAR_BUDGET,
      );
      enrichedBody.market_research = content;
      console.log(
        `[funnel-swap-proxy] research routing pageType=${pageType} task=${task} ` +
        `selected=${selection.selected.length}/${researchPayload.files.length} ` +
        `chars=${selection.totalChars}/${selection.budgetChars} ` +
        `kept=[${selection.selected.map((f) => f.name).join(', ')}] ` +
        `skipped=[${selection.skipped.map((s) => `${s.file.name}(${s.reason})`).join(', ')}]`,
      );
    }
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
  const briefChars = typeof enrichedBody.brief === 'string' ? enrichedBody.brief.length : 0;
  const researchChars =
    typeof enrichedBody.market_research === 'string' ? enrichedBody.market_research.length : 0;
  console.log(
    `[funnel-swap-proxy] phase=${phase || '?'} cloneMode=${cloneMode || '?'} ` +
    `pageType=${(body.pageType as string) || '?'} kb=${kbInjected ? 'yes' : 'no'} ` +
    `briefChars=${briefChars} researchChars=${researchChars} ` +
    `status=${response.status} time=${elapsedMs}ms`,
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
