import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';
import { supabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req, 'read_templates');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data, error } = await supabase.from('swipe_templates').select('*').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ templates: data, api_key: auth.apiKey.name });
}

export async function POST(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_templates');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json();
  const { data, error } = await supabase.from('swipe_templates').insert(body).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ template: data });
}
