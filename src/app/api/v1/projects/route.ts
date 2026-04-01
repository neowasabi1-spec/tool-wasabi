import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';
import { supabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req, 'read_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ project: data });
  }

  const status = req.nextUrl.searchParams.get('status');
  let query = supabase.from('projects').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ projects: data, count: data?.length || 0 });
}

export async function POST(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json();
  if (!body.name) return NextResponse.json({ error: 'Missing name' }, { status: 400 });

  const insert = {
    name: body.name,
    description: body.description || '',
    status: body.status || 'active',
    tags: body.tags || [],
    notes: body.notes || '',
    domain: body.domain || '',
    logo: body.logo || [],
    market_research: body.market_research || body.marketResearch || {},
    brief: body.brief || '',
    front_end: body.front_end || body.frontEnd || {},
    back_end: body.back_end || body.backEnd || {},
    compliance_funnel: body.compliance_funnel || body.complianceFunnel || {},
    funnel: body.funnel || {},
  };

  const { data, error } = await supabase.from('projects').insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data });
}

export async function PUT(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id, ...updates } = await req.json();
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const mapped: Record<string, unknown> = {};
  const fieldMap: Record<string, string> = {
    marketResearch: 'market_research',
    frontEnd: 'front_end',
    backEnd: 'back_end',
    complianceFunnel: 'compliance_funnel',
  };
  for (const [k, v] of Object.entries(updates)) {
    mapped[fieldMap[k] || k] = v;
  }

  const { data, error } = await supabase.from('projects').update(mapped).eq('id', id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data });
}

export async function DELETE(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
