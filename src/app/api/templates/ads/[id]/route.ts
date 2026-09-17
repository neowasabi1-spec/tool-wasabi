import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { resolveAdType, upsertArchiveAdType } from '@/lib/archive-ad-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type AdRow = {
  id: string;
  name: string;
  ad_type: string;
  category: string;
  media_type: string;
  file_path: string;
  tags: string;
  headline: string;
  primary_text: string;
};

async function loadRow(id: string): Promise<AdRow | null> {
  const { data } = await supabaseAdmin
    .from('archive_ads')
    .select('id, name, ad_type, category, media_type, file_path, tags, headline, primary_text')
    .eq('id', id)
    .maybeSingle();
  return (data as AdRow | null) || null;
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const row = await loadRow(params.id);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, string> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 300);
  if (typeof body.category === 'string') patch.category = body.category.trim().slice(0, 60);
  if (typeof body.tags === 'string') patch.tags = body.tags.slice(0, 4000);
  if (typeof body.headline === 'string') patch.headline = body.headline.slice(0, 300);
  if (typeof body.primary_text === 'string') patch.primary_text = body.primary_text.slice(0, 4000);
  if (typeof body.ad_type === 'string' || typeof body.adType === 'string') {
    const resolved = resolveAdType(String(body.ad_type || body.adType || ''), String(body.adTypeLabel || ''));
    patch.ad_type = resolved.value;
    if (resolved.isCustom) {
      await upsertArchiveAdType(userId, resolved.value, resolved.label);
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('archive_ads')
    .update(patch)
    .eq('id', params.id)
    .select()
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message || 'Update failed' }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const row = await loadRow(params.id);
  if (!row) return NextResponse.json({ ok: true });

  if (row.file_path && row.file_path.startsWith('archive-ads/')) {
    await supabaseAdmin.storage.from('project-files').remove([row.file_path]).catch(() => {});
  }

  const { error } = await supabaseAdmin.from('archive_ads').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
