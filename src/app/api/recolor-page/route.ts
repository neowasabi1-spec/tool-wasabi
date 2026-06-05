import { NextRequest, NextResponse } from 'next/server';
import { recolorPage, type Palette } from '@/lib/recolor-page';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/**
 * POST /api/recolor-page
 *
 * Backwards-compat wrapper around the pure helper in `@/lib/recolor-page`.
 *
 * Why this is kept thin:
 * - The recolouring logic is 100% deterministic (color parsing + role
 *   assignment + regex swap), no LLM, no DB, no auth — so it can run
 *   identically in the browser.
 * - Big landings (cloned pages with inline base64 images and heavy CSS)
 *   easily exceed Netlify's 6MB request body cap; the route used to
 *   surface that as "Server returned non-JSON (HTTP 500)" because Netlify
 *   short-circuits with an HTML error page before our function runs.
 * - The fix is for callers (VisualHtmlEditor → handleApplyBrandColors)
 *   to import `recolorPage()` directly and skip the network entirely.
 *   This endpoint remains so external scripts / older callers keep
 *   working with reasonably-sized HTML.
 */

interface Body {
  html: string;
  palette: Palette;
}

export async function POST(request: NextRequest) {
  try {
    const body: Body = await request.json();
    const { html, palette } = body;

    if (!html || typeof html !== 'string') {
      return NextResponse.json({ ok: false, error: 'html is required' }, { status: 400 });
    }
    if (!palette || typeof palette !== 'object') {
      return NextResponse.json({ ok: false, error: 'palette is required' }, { status: 400 });
    }

    const result = recolorPage(html, palette);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error('[api/recolor-page] Error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    // Surface palette validation as 400, generic failures as 500.
    const status = /palette must contain/.test(msg) ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
