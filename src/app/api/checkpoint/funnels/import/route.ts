import { NextRequest, NextResponse } from 'next/server';
import { createFunnelsBatch } from '@/lib/checkpoint-store';
import type { CreateCheckpointFunnelInput } from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ImportBody {
  projectId?: string;
  items?: Array<{
    name?: string;
    url?: string;
    notes?: string;
  }>;
}

/**
 * POST /api/checkpoint/funnels/import
 *
 * Body: { projectId?: string, items: [{ name?, url, notes? }] }
 *
 * Bulk-creates `checkpoint_funnels` rows from an arbitrary URL list.
 * Used by the "Import to Checkpoint" modal in the Projects page so
 * the user can pull all the front-end + back-end funnel steps into
 * the audit library in one click.
 *
 * Returns: { created: CheckpointFunnel[], skipped: [...] }
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
