/**
 * Sidecar persistence for the per-step checkout flavour.
 *
 * Only used when `funnel_pages.checkout_mode` does not exist yet (the
 * migration hasn't been applied). See src/lib/checkout-mode-fallback.ts for
 * the full rationale and the precedence rules.
 *
 *   GET  /api/checkout-mode   -> { columnExists, modes: { "<pageId>": "wasabi" } }
 *   PUT  /api/checkout-mode   -> { pageId, checkoutMode, knownPageIds? }
 *
 * Both are best-effort: a failure here must never break the funnel table, it
 * just means the choice doesn't survive a reload (the behaviour before this
 * route existed).
 */

import { NextRequest, NextResponse } from 'next/server';
import { normalizeCheckoutMode } from '@/lib/checkout-modes';
import { columnExists, readAllModes, writeMode } from '@/lib/checkout-mode-fallback';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [hasColumn, modes] = await Promise.all([columnExists(), readAllModes()]);
    return NextResponse.json({ columnExists: hasColumn, modes });
  } catch (err) {
    console.error('[api/checkout-mode] GET failed:', err);
    // Degrade to "nothing is wasabi" rather than surfacing an error.
    return NextResponse.json({ columnExists: false, modes: {} });
  }
}

export async function PUT(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const pageId = typeof body.pageId === 'string' ? body.pageId : '';
  if (!pageId) {
    return NextResponse.json({ error: 'pageId is required' }, { status: 400 });
  }

  const mode = normalizeCheckoutMode(body.checkoutMode);
  const knownPageIds = Array.isArray(body.knownPageIds)
    ? body.knownPageIds.filter((v): v is string => typeof v === 'string')
    : undefined;

  const result = await writeMode(pageId, mode, knownPageIds);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? 'write failed', persisted: false, mode },
      { status: 200 }, // deliberately not a 5xx: the UI keeps working regardless
    );
  }
  return NextResponse.json({ persisted: true, mode });
}
