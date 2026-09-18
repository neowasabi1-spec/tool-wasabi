import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { formatAdTags, parseAdTags } from '@/lib/ad-tags';
import { resolveAdType, upsertArchiveAdType } from '@/lib/archive-ad-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const BUCKET = 'project-files';

/**
 * POST /api/projecthub/projects/:id/competitor-library/:cid/ads/save-to-templates
 * Copies competitor ads into the shared Template → Ads library.
 * Body: { ad_ids, ad_type?, category?, newFolder?, tags? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; cid: string } },
) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id, cid } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const adIds = Array.isArray(body.ad_ids)
    ? body.ad_ids.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n))
    : [];
  if (adIds.length === 0) return NextResponse.json({ error: 'Pick at least one ad' }, { status: 400 });

  const resolved = resolveAdType(String(body.ad_type || body.adType || ''), String(body.adTypeLabel || ''));
  if (resolved.isCustom) {
    await upsertArchiveAdType(userId, resolved.value, resolved.label);
  }

  const folderName = String(body.newFolder || body.category || '').trim().slice(0, 60);
  const tags = formatAdTags(parseAdTags(String(body.tags || '')));

  const { data: ads, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, name, headline, hook, body_text, file_path, media_type')
    .eq('project_id', id)
    .eq('brand_id', Number(cid))
    .in('id', adIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (folderName) {
    const { data: dupe } = await supabaseAdmin
      .from('archive_ads')
      .select('id')
      .eq('ad_type', resolved.value)
      .eq('media_type', 'folder')
      .ilike('name', folderName)
      .maybeSingle();
    if (!dupe) {
      const { error: folderErr } = await supabaseAdmin.from('archive_ads').insert({
        name: folderName,
        ad_type: resolved.value,
        category: '',
        media_type: 'folder',
        file_path: '',
        tags: '',
        headline: '',
        primary_text: '',
        owner_user_id: userId,
      });
      if (folderErr) {
        return NextResponse.json({ error: folderErr.message || 'Could not create folder' }, { status: 500 });
      }
    }
  }

  const created: unknown[] = [];
  for (const ad of (ads || []) as Array<{
    id: number;
    name: string;
    headline: string;
    hook: string;
    body_text: string;
    file_path: string;
    media_type: string;
  }>) {
    const dest = await copyAdFile(String(ad.file_path || ''), userId);
    const mediaType = ad.media_type === 'video' ? 'video' : 'image';
    const { data: row, error: insErr } = await supabaseAdmin
      .from('archive_ads')
      .insert({
        name: (ad.name || ad.headline || 'Creative').slice(0, 300),
        ad_type: resolved.value,
        category: folderName,
        media_type: mediaType,
        file_path: dest,
        tags,
        headline: String(ad.headline || '').slice(0, 300),
        primary_text: String(ad.body_text || ad.hook || '').slice(0, 4000),
        owner_user_id: userId,
      })
      .select()
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    created.push(row);
  }

  return NextResponse.json({
    ok: true,
    ads: created,
    count: created.length,
    ad_type: resolved.value,
    folder: folderName,
  });
}

async function copyAdFile(src: string, userId: string): Promise<string> {
  const path = String(src || '').trim();
  if (!path) return '';
  if (path.startsWith('archive-ads/')) return path;
  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path);
    if (error || !data) return path;
    const buf = Buffer.from(await data.arrayBuffer());
    if (buf.length < 40) return path;
    const ext = (path.split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
    const dest = `archive-ads/${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const mime = data.type || 'application/octet-stream';
    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(dest, buf, {
      contentType: mime,
      upsert: false,
    });
    return upErr ? path : dest;
  } catch {
    return path;
  }
}
