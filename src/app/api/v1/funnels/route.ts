import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';
import { supabase } from '@/lib/supabase';
import { offloadFunnelPagePayload } from '@/lib/server/funnel-html-offload';

export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req, 'read_funnels');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data, error } = await supabase.from('funnel_pages').select('*').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ funnels: data, api_key: auth.apiKey.name });
}

export async function POST(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_funnels');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json();

  if (body.id) {
    // Id known upfront → offload the heavy HTML to page_html BEFORE writing
    // the JSONB, so the row never carries multi-MB blobs.
    const slim = await offloadFunnelPagePayload(supabase, String(body.id), body);
    const { data, error } = await supabase
      .from('funnel_pages')
      .upsert(slim, { onConflict: 'id' })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ funnel_page: data });
  }

  // No id yet: insert first (light columns need the generated id for the
  // page_html key), then offload and patch the blobs in a second write.
  const { cloned_data, swiped_data, extracted_data, ...light } = body;
  const { data, error } = await supabase.from('funnel_pages').insert(light).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const heavy: Record<string, unknown> = {};
  if (cloned_data) heavy.cloned_data = cloned_data;
  if (swiped_data) heavy.swiped_data = swiped_data;
  if (extracted_data) heavy.extracted_data = extracted_data;
  if (Object.keys(heavy).length) {
    const slim = await offloadFunnelPagePayload(supabase, String(data.id), heavy);
    const { data: patched, error: patchErr } = await supabase
      .from('funnel_pages')
      .update(slim)
      .eq('id', data.id)
      .select()
      .single();
    if (patchErr) return NextResponse.json({ error: patchErr.message }, { status: 500 });
    return NextResponse.json({ funnel_page: patched });
  }
  return NextResponse.json({ funnel_page: data });
}

export async function PUT(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_funnels');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id, ...updates } = await req.json();
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const slim = await offloadFunnelPagePayload(supabase, String(id), updates);
  const { data, error } = await supabase.from('funnel_pages').update(slim).eq('id', id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ funnel_page: data });
}

export async function DELETE(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_funnels');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const { error } = await supabase.from('funnel_pages').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
