import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const project_id = req.nextUrl.searchParams.get('project_id');
  let query = supabase.from('funnel_flows').select('*').order('created_at', { ascending: false });
  if (project_id) query = query.eq('project_id', project_id);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ flows: data, count: data?.length || 0 });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.project_id) return NextResponse.json({ error: 'Missing project_id' }, { status: 400 });
  if (!body.name) return NextResponse.json({ error: 'Missing name' }, { status: 400 });

  const insert = {
    project_id: body.project_id,
    name: body.name,
    description: body.description || null,
    status: body.status || 'draft',
    is_active: body.is_active || false,
  };

  const { data, error } = await supabase.from('funnel_flows').insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ flow: data });
}
