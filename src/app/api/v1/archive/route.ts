import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';
import { supabase } from '@/lib/supabase';
import { listArchiveCards } from '@/lib/slim-archived-funnels';

export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req, 'read_archive');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sp = req.nextUrl.searchParams;
  const pageType = (sp.get('type') || sp.get('pageType') || '').trim();
  const limit = Number(sp.get('limit'));
  const offset = Number(sp.get('offset'));
  try {
    const listed = await listArchiveCards({
      origin: req.nextUrl.origin,
      pageType: pageType || undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    });
    return NextResponse.json({
      archived_funnels: listed.pages,
      pages: listed.pages,
      count: listed.count,
      limit: listed.limit,
      offset: listed.offset,
      api_key: auth.apiKey.name,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Archive list failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_archive');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json();
  const { data, error } = await supabase.from('archived_funnels').insert(body).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ archived_funnel: data });
}
