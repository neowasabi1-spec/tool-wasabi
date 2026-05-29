import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const MIGRATION_HINT =
  'Migration not run — execute supabase-migration-projecthub.sql (funnel_steps)';

// Whitelist of writable columns on funnel_steps. Keeps the insert/patch
// payload safe and avoids "column does not exist" surprises.
const WRITABLE = [
  'step_number',
  'page_name',
  'step_type',
  'template_name',
  'url',
  'html_file_path',
  'html_original_name',
  'target',
  'angle',
  'prompt_notes',
  'auto_gen',
  'fidelity_mode',
  'product',
  'status',
  'result_content',
  'feedback',
] as const;

function pickWritable(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE) {
    if (src[key] !== undefined && src[key] !== null) out[key] = src[key];
  }
  return out;
}

/** GET — list every funnel step for a project, ordered by step number. */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { data, error } = await supabase
    .from('funnel_steps')
    .select('*')
    .eq('project_id', params.id)
    .order('step_number', { ascending: true });

  if (error) {
    if (/does not exist|funnel_steps/i.test(error.message || '')) {
      return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

/** POST — create one step, or many at once when the body is `{ steps: [...] }`.
 *  Returns the created row (single) or the created rows (bulk). */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = await req.json().catch(() => ({}));

  // Bulk insert path: { steps: [...] } — used by "Save funnel into project".
  if (Array.isArray(body?.steps)) {
    if (body.steps.length === 0) {
      return NextResponse.json({ error: 'steps array is empty' }, { status: 400 });
    }
    const rows = (body.steps as Record<string, unknown>[]).map((s, i) => ({
      ...pickWritable(s),
      project_id: params.id,
      step_number:
        typeof s.step_number === 'number' ? s.step_number : i + 1,
    }));

    const { data, error } = await supabase
      .from('funnel_steps')
      .insert(rows)
      .select('*');

    if (error) {
      if (/does not exist|funnel_steps/i.test(error.message || '')) {
        return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(data ?? [], { status: 201 });
  }

  // Single insert path — used by the Funnel tab "Aggiungi Step" button.
  const row = {
    ...pickWritable(body as Record<string, unknown>),
    project_id: params.id,
    step_number:
      typeof body?.step_number === 'number' ? body.step_number : 1,
  };

  const { data, error } = await supabase
    .from('funnel_steps')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    if (/does not exist|funnel_steps/i.test(error.message || '')) {
      return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
