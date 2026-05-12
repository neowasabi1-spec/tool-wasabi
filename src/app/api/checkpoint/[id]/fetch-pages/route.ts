import { NextRequest, NextResponse } from 'next/server';
import {
  getFunnel,
  fetchFunnelPagesHtml,
} from '@/lib/checkpoint-store';
import { htmlToAuditText } from '@/lib/checkpoint-prompts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/checkpoint/[id]/fetch-pages
 *
 * Body (optional):
 *   {
 *     mode?: 'text' | 'html' | 'both',   // default: 'text'
 *     maxCharsPerPage?: number,           // applies to text/html alike
 *   }
 *
 * Returns the live page contents of every step of the funnel, in
 * order. Designed for external auditors (OpenClaw via MCP) that want
 * to perform their OWN analysis instead of triggering the built-in
 * Claude pipeline.
 *
 * Modes:
 *   - 'text'  → only the audit-friendly text extraction (compact,
 *               cheap to ship over MCP, ~30KB/page max).
 *   - 'html'  → only the raw HTML as fetched (much larger; useful
 *               when the auditor needs to reason on structure).
 *   - 'both'  → ship both. Use when bandwidth isn't a concern.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing funnel id' }, { status: 400 });
  }

  let body: {
    mode?: 'text' | 'html' | 'both';
    maxCharsPerPage?: number;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const mode = body.mode === 'html' || body.mode === 'both' ? body.mode : 'text';
  const maxChars =
    typeof body.maxCharsPerPage === 'number' && body.maxCharsPerPage > 1000
      ? Math.min(body.maxCharsPerPage, 200_000)
      : 30_000;

  const funnel = await getFunnel(id);
  if (!funnel) {
    return NextResponse.json({ error: 'Funnel not found' }, { status: 404 });
  }
  if (!funnel.pages || funnel.pages.length === 0) {
    return NextResponse.json(
      { error: 'Funnel has no pages configured.' },
      { status: 422 },
    );
  }

  const t0 = Date.now();
  const fetched = await fetchFunnelPagesHtml(funnel.pages);

  const pages = fetched.map((p) => {
    const out: Record<string, unknown> = {
      index: p.index,
      url: p.url,
      name: p.name ?? null,
      ok: !!p.html,
      htmlLength: p.htmlLength,
      error: p.error,
    };
    if (p.html) {
      if (mode === 'text' || mode === 'both') {
        out.text = htmlToAuditText(p.html, maxChars);
      }
      if (mode === 'html' || mode === 'both') {
        out.html = p.html.length > maxChars ? p.html.slice(0, maxChars) : p.html;
        out.htmlTruncated = p.html.length > maxChars;
      }
    }
    return out;
  });

  return NextResponse.json({
    funnelId: funnel.id,
    funnelName: funnel.name,
    pageCount: funnel.pages.length,
    reachableCount: pages.filter((p) => p.ok).length,
    durationMs: Date.now() - t0,
    mode,
    maxCharsPerPage: maxChars,
    pages,
  });
}
