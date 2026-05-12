import { NextRequest, NextResponse } from 'next/server';
import { createFunnel, createFunnelsBatch } from '@/lib/checkpoint-store';
import type {
  CheckpointFunnelPage,
  CreateCheckpointFunnelInput,
} from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ImportBody {
  projectId?: string;
  /**
   * 'multi'  (default v2) — collapse all items into a single
   *                          checkpoint_funnels row with pages = items.
   *                          One funnel = one ordered sequence.
   * 'single' (legacy)     — create one checkpoint_funnels row per item.
   *                          Each page becomes its own audit entry.
   */
  mode?: 'multi' | 'single';
  /** Optional name for the resulting funnel (only honoured in 'multi' mode). */
  name?: string;
  items?: Array<{
    name?: string;
    url?: string;
    notes?: string;
  }>;
}

/**
 * POST /api/checkpoint/funnels/import
 *
 * Bulk-import a list of funnel-step URLs from a project / front-end-funnel
 * row into the Checkpoint library.
 *
 * v2 behaviour: by default we collapse the items into ONE multi-page
 * checkpoint funnel (the "navigation" check needs the full sequence).
 * Pass `mode: 'single'` to keep the legacy "one row per page" import
 * for cases where the user wants per-page audits.
 *
 * Returns:
 *   - mode 'multi'  → { created: [oneFunnel], skipped: [] }
 *   - mode 'single' → { created: CheckpointFunnel[], skipped: [...] }
 */
export async function POST(req: NextRequest) {
  let body: ImportBody;
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    return NextResponse.json({ error: 'Body JSON non valido.' }, { status: 400 });
  }
  if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json(
      { error: 'Nessun item da importare.' },
      { status: 400 },
    );
  }

  const projectId = body.projectId?.trim() || undefined;
  const mode: 'multi' | 'single' = body.mode === 'single' ? 'single' : 'multi';

  if (mode === 'multi') {
    const pages: CheckpointFunnelPage[] = body.items
      .map((it) => ({
        url: (it.url ?? '').trim(),
        name: it.name?.trim() || undefined,
      }))
      .filter((p) => p.url);
    if (pages.length === 0) {
      return NextResponse.json(
        { error: 'Tutti gli item passati hanno URL vuoto.' },
        { status: 400 },
      );
    }
    const result = await createFunnel({
      pages,
      name: body.name?.trim() || undefined,
      project_id: projectId,
    });
    if ('error' in result) {
      return NextResponse.json(
        { error: result.error, created: [], skipped: [] },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { created: [result], skipped: [] },
      { status: 201 },
    );
  }

  // Legacy single-mode: one row per item.
  const inputs: CreateCheckpointFunnelInput[] = body.items.map((it) => ({
    name: it.name?.trim() || undefined,
    url: (it.url ?? '').trim(),
    notes: it.notes?.trim() || undefined,
    project_id: projectId,
  }));

  const result = await createFunnelsBatch(inputs);
  return NextResponse.json(
    { created: result.created, skipped: result.skipped },
    { status: result.created.length > 0 ? 201 : 200 },
  );
}
