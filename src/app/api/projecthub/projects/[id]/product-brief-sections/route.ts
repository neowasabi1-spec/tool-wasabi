import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const DEFAULTS = [{ id: 'pb_frontend', label: 'Frontend' }];

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { data, error } = await supabase
    .from('projects')
    .select('product_brief_sections')
    .eq('id', params.id)
    .single();

  if (error) {
    if (/product_brief_sections/i.test(error.message || '')) {
      return NextResponse.json(DEFAULTS);
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json(DEFAULTS);

  const raw = (data as { product_brief_sections?: string }).product_brief_sections;
  try {
    const parsed = raw ? JSON.parse(raw) : DEFAULTS;
    return NextResponse.json(Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULTS);
  } catch {
    return NextResponse.json(DEFAULTS);
  }
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
