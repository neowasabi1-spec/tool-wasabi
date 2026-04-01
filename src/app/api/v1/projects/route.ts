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

    const [funnelPages, templates, archives] = await Promise.all([
      supabase.from('funnel_pages').select('*').eq('project_id', id).order('created_at', { ascending: false }),
      supabase.from('swipe_templates').select('*').eq('project_id', id).order('created_at', { ascending: false }),
      supabase.from('archived_funnels').select('*').eq('project_id', id).order('created_at', { ascending: false }),
    ]);

    return NextResponse.json({
      project: data,
      funnel_pages: funnelPages.data || [],
      templates: templates.data || [],
      archived_funnels: archives.data || [],
    });
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

  const insert: Record<string, unknown> = {
    name: body.name,
    description: body.description || '',
    status: body.status || 'active',
    tags: body.tags || [],
    notes: body.notes || '',
  };

  const optionalJsonFields: Record<string, string[]> = {
    domain: ['domain'],
    logo: ['logo'],
    market_research: ['market_research', 'marketResearch'],
    brief: ['brief'],
    front_end: ['front_end', 'frontEnd'],
    back_end: ['back_end', 'backEnd'],
    compliance_funnel: ['compliance_funnel', 'complianceFunnel'],
    funnel: ['funnel'],
  };

  for (const [col, keys] of Object.entries(optionalJsonFields)) {
    const val = keys.map(k => body[k]).find(v => v !== undefined);
    if (val !== undefined) insert[col] = val;
  }

  if (body.id) {
    insert.id = body.id;
    const { data, error } = await supabase.from('projects').upsert(insert, { onConflict: 'id' }).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ project: data });
  }

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
