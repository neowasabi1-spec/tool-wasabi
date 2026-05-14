import { NextRequest, NextResponse } from 'next/server';
import {
  getFunnel,
  listRunsForFunnel,
  deleteFunnel,
  updateFunnelPagesType,
} from '@/lib/checkpoint-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/checkpoint/[id]
 *
 * Returns: { funnel: CheckpointFunnel, runs: CheckpointRun[] }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }
  const funnel = await getFunnel(id);
  if (!funnel) {
    return NextResponse.json({ error: 'Funnel not found' }, { status: 404 });
  }
  const runs = await listRunsForFunnel(id);
  return NextResponse.json({ funnel, runs });
}

/**
 * PATCH /api/checkpoint/[id]
 * Body: { pageType: string | null }
 *
 * Bulk-sets the page-type on every step of the funnel. Used by the
 * "Tipo funnel" inline editor on the detail page so the user can
 * retag a funnel that was created via auto-discover (which doesn't
 * ask for a type) — once `pageType` is e.g. 'quiz_funnel' on every
 * step, the next checkpoint run picks the quiz-specific rubric
 * automatically (see `isAllQuizSteps` in `checkpoint-prompts.ts`).
 *
 * Pass `pageType: null` to clear the type back to "default rubric".
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }
  let body: { pageType?: string | null };
  try {
    body = (await req.json()) as { pageType?: string | null };
  } catch {
    return NextResponse.json({ error: 'Body JSON non valido.' }, { status: 400 });
  }
  // `pageType` is required to disambiguate from "missing field" — but
  // can be null (= clear) or a string (= set).
  if (!('pageType' in body)) {
    return NextResponse.json(
      { error: "Field 'pageType' is required (string or null)." },
      { status: 400 },
    );
  }
  const result = await updateFunnelPagesType(id, body.pageType ?? null);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ funnel: result.funnel });
}

/**
 * DELETE /api/checkpoint/[id]
 * Removes the funnel + cascades the runs.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }
  const result = await deleteFunnel(id);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
