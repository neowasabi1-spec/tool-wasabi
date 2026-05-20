import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { derivedProductBriefSections } from '@/lib/projecthub-legacy';

export const dynamic = 'force-dynamic';

const FETCH_COLS = [
  'id',
  'product_brief_sections',
  'market_research',
  'brief',
  'front_end',
  'back_end',
  'compliance_funnel',
  'funnel',
];

/** GET — return the user's product-brief tabs.
 *
 *  We always feed the row through `derivedProductBriefSections`, so any tab
 *  whose data still lives only in a legacy JSONB section column (e.g. a
 *  "Backend" tab inferred from a populated `back_end` column) shows up in
 *  the UI even though it was never explicitly persisted to
 *  `product_brief_sections`. The user's own ordering / labels stored in
 *  that JSON column always win. */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  // Try fetching with all columns; if any are missing, fall back to a
  // minimal set so this endpoint never 500s.
  const tryWith = async (cols: string[]) =>
    supabase.from('projects').select(cols.join(', ')).eq('id', params.id).single();

  let { data: project, error } = await tryWith(FETCH_COLS);
  if (error && /does not exist/i.test(error.message || '')) {
    ({ data: project, error } = await tryWith([
      'id',
      'product_brief_sections',
    ]));
  }
  if (error && /product_brief_sections/i.test(error.message || '')) {
    ({ data: project, error } = await tryWith(['id']));
  }

  if (error || !project) {
    return NextResponse.json([{ id: 'pb_frontend', label: 'Frontend' }]);
  }

  const sections = derivedProductBriefSections(
    project as unknown as Record<string, unknown>,
  );
  return NextResponse.json(sections);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = await req.json().catch(() => ({}));
  const sections = body.sections;
  if (!Array.isArray(sections)) {
    return NextResponse.json({ error: 'sections array required' }, { status: 400 });
  }

  const { error } = await supabase
    .from('projects')
    .update({ product_brief_sections: JSON.stringify(sections) })
    .eq('id', params.id);

  if (error) {
    if (/product_brief_sections/i.test(error.message || '')) {
      return NextResponse.json(
        { error: 'Migration not run — execute supabase-migration-projecthub.sql' },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, sections });
}
