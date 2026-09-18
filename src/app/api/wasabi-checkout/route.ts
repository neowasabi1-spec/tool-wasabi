/**
 * POST /api/wasabi-checkout   { html, mode?, productName?, brandName?, notes?, audit? }
 *
 * Makes a checkout page satisfy the WasabiCRM binding contract, and is the
 * only place in the app that does. Called from:
 *   - front-end-funnel/page.tsx  after Clone & Rewrite / Swipe All finish a row
 *                                whose checkout flavour is WasabiCRM
 *   - VisualHtmlEditor           the "WasabiCRM-ready" button
 *
 * `mode` is passed through normalizeCheckoutMode, so a row that is NOT a
 * WasabiCRM checkout gets its HTML back byte-identical and no model is called.
 * That keeps the route safe to call unconditionally from the funnel flow.
 *
 * `audit: true` reports without changing anything — used to show the badge in
 * the editor.
 */
import { NextRequest, NextResponse } from 'next/server';
import { normalizeCheckoutMode } from '@/lib/checkout-modes';
import { auditWasabiCheckout, fatalIssues } from '@/lib/wasabi-checkout-contract';
import { convertToWasabiCheckout } from '@/lib/wasabi-checkout-build';

// The conversion is one or two Opus round-trips over a whole page.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${err instanceof Error ? err.message : 'parse error'}` },
      { status: 400 },
    );
  }

  const html = typeof body.html === 'string' ? body.html : '';
  if (!html.trim()) {
    return NextResponse.json({ error: 'html is required' }, { status: 400 });
  }

  // Audit-only: no model, no mutation.
  if (body.audit === true) {
    const issues = auditWasabiCheckout(html);
    return NextResponse.json({
      audited: true,
      ready: fatalIssues(issues).length === 0,
      issues,
      fatalCount: fatalIssues(issues).length,
    });
  }

  // A standard checkout / any other page type leaves here untouched, so the
  // caller can fire this without first deciding whether it applies.
  const mode = normalizeCheckoutMode(body.mode ?? 'wasabi');
  if (mode !== 'wasabi') {
    return NextResponse.json({
      html,
      ready: true,
      skipped: 'checkout mode is not WasabiCRM — HTML returned unchanged',
      issues: [],
      repairs: [],
      log: [],
      attempts: 0,
      aiUsed: false,
    });
  }

  const t0 = Date.now();
  try {
    const result = await convertToWasabiCheckout({
      html,
      productName: typeof body.productName === 'string' ? body.productName : undefined,
      brandName: typeof body.brandName === 'string' ? body.brandName : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      maxAttempts: typeof body.maxAttempts === 'number' ? body.maxAttempts : undefined,
    });

    console.log(
      `[wasabi-checkout] ${html.length} -> ${result.html.length} chars, ` +
        `ready=${result.ready} attempts=${result.attempts} ` +
        `repairs=${result.repairs.length} fatal=${fatalIssues(result.issues).length} ` +
        `time=${Date.now() - t0}ms`,
    );

    return NextResponse.json({
      html: result.html,
      ready: result.ready,
      issues: result.issues,
      fatalCount: fatalIssues(result.issues).length,
      repairs: result.repairs,
      log: result.log,
      attempts: result.attempts,
      aiUsed: result.aiUsed,
      error: result.error,
    });
  } catch (err) {
    // convertToWasabiCheckout is written not to throw, but a caller must never
    // lose a page to this route — hand the original HTML back with the reason.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[wasabi-checkout] unhandled:', msg);
    return NextResponse.json(
      {
        html,
        ready: false,
        issues: auditWasabiCheckout(html),
        repairs: [],
        log: [`Conversion crashed: ${msg} — the page was returned unchanged.`],
        attempts: 0,
        aiUsed: false,
        error: msg,
      },
      { status: 200 },
    );
  }
}
