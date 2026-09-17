import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { isMissingAdTypesTable, resolveAdType, upsertArchiveAdType } from '@/lib/archive-ad-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type ArchiveAdRow = {
  id: string;
  name: string;
  ad_type: string;
  category: string;
  media_type: string;
  file_path: string;
  tags: string;
  headline: string;
  primary_text: string;
  owner_user_id: string | null;
  created_at: string;
};

/**
 * GET — shared Ads template library.
 * POST — register an uploaded file (after /sign-upload) in a type folder.
 *
 * Body: { name, file_path, media_type, ad_type, category? }
 */
export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('archive_ads')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    if (isMissingAdTypesTable(error.message)) {
      return NextResponse.json({ success: true, ads: [], missingTable: true });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, ads: (data || []) as ArchiveAdRow[] });
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 300);
  const filePath = String(body.file_path || '').trim();
  const mediaType = body.media_type === 'video' ? 'video' : 'image';
  if (!filePath) return NextResponse.json({ error: 'file_path required' }, { status: 400 });
  if (!filePath.startsWith('archive-ads/')) {
    return NextResponse.json({ error: 'Invalid file_path' }, { status: 400 });
  }

  const resolved = resolveAdType(String(body.ad_type || body.adType || ''), String(body.adTypeLabel || ''));
  if (resolved.isCustom) {
    await upsertArchiveAdType(userId, resolved.value, resolved.label);
  }

  const category = String(body.category || '').trim().slice(0, 60);
  const row = {
    name: name || 'Ad template',
    ad_type: resolved.value,
    category,
    media_type: mediaType,
    file_path: filePath,
    tags: String(body.tags || '').slice(0, 4000),
    headline: String(body.headline || '').slice(0, 300),
    primary_text: String(body.primary_text || '').slice(0, 4000),
    owner_user_id: userId,
  };

  const { data, error } = await supabaseAdmin
    .from('archive_ads')
    .insert(row)
    .select()
    .single();

  if (error || !data) {
    if (isMissingAdTypesTable(error?.message)) {
      return NextResponse.json(
        { error: 'Ads library tables are missing. Run supabase-migration-archive-ads.sql on Supabase.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: error?.message || 'Insert failed' }, { status: 500 });
  }

  if (category) {
    try {
      await supabaseAdmin
        .from('archive_categories')
        .upsert({ name: category, owner_user_id: userId }, { onConflict: 'owner_user_id,name' });
    } catch {
      /* ignore */
    }
  }

  return NextResponse.json(data);
}
