import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data, error } = await supabase
    .from('flow_steps')
    .select('*')
    .eq('flow_id', id)
    .order('step_number', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ steps: data, count: data?.length || 0 });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: flow_id } = await params;
  const body = await req.json();

  // Get max step_number for this flow
  const { data: existing } = await supabase
    .from('flow_steps')
    .select('step_number')
    .eq('flow_id', flow_id)
    .order('step_number', { ascending: false })
    .limit(1);

  const nextStep = existing && existing.length > 0 ? (existing[0].step_number + 1) : 1;

  const insert = {
    flow_id,
    project_id: body.project_id || null,
    step_number: body.step_number || nextStep,
    step_type: body.step_type || 'page',
    name: body.name || 'New Step',
    copy_text: body.copy_text || null,
    html_content: body.html_content || null,
    live_url: body.live_url || null,
    preview_image: body.preview_image || null,
    status: body.status || 'draft',
    visits: body.visits || 0,
    conversions: body.conversions || 0,
    cvr: body.cvr || 0,
    revenue: body.revenue || 0,
    price: body.price || null,
    offer_type: body.offer_type || null,
  };

  const { data, error } = await supabase.from('flow_steps').insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ step: data });
}
