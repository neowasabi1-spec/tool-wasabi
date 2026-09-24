import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { extForContentType } from '@/lib/competitor-ads';
import { isMissingAdTypesTable, resolveAdType, upsertArchiveAdType } from '@/lib/archive-ad-types';
import { classifyArchiveAd } from '@/lib/classify-archive-ad';
import { formatAdTags, parseAdTags } from '@/lib/ad-tags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BUCKET = 'project-files';
const MAX_SIZE = 20 * 1024 * 1024;

const EXT_IMAGE: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic',
};
const EXT_VIDEO: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
};

function inferMedia(file: File): { media: 'image' | 'video'; contentType: string } | null {
  const type = (file.type || '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('image/')) return { media: 'image', contentType: type };
  if (type.startsWith('video/')) return { media: 'video', contentType: type };
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (EXT_IMAGE[ext]) return { media: 'image', contentType: EXT_IMAGE[ext] };
  if (EXT_VIDEO[ext]) return { media: 'video', contentType: EXT_VIDEO[ext] };
  return null;
}

/**
 * Multipart upload for Template → Ads.
 * Uses the service-role client so it does not depend on a browser Supabase
 * session (wasabi_session is never attached to getSupabaseBrowser()).
 *
 * Form fields: file, ad_type, category?
 */
export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: `Upload too large or unreadable: ${e instanceof Error ? e.message : 'parse failed'}` },
      { status: 413 },
    );
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: `File too large (max ${MAX_SIZE / 1024 / 1024}MB)` }, { status: 400 });
  }

  const inferred = inferMedia(file);
  if (!inferred) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || file.name}` },
      { status: 400 },
    );
  }

  const classified = classifyArchiveAd({
    mediaType: inferred.media,
    name: file.name,
  });
  const rawType = String(form.get('ad_type') || '').trim();
  const auto = !rawType || rawType === 'auto';
  const resolved = resolveAdType(auto ? classified.ad_type : rawType, '');
  if (resolved.isCustom) {
    await upsertArchiveAdType(userId, resolved.value, resolved.label);
  }

  const ext = extForContentType(inferred.contentType, inferred.media === 'video' ? 'mp4' : 'jpg');
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `archive-ads/${userId}/${Date.now()}_${rand}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, buffer, {
    contentType: inferred.contentType,
    upsert: false,
  });
  if (upErr) {
    return NextResponse.json(
      { error: upErr.message.includes('Bucket not found')
        ? 'Storage bucket "project-files" not found. Create it in Supabase → Storage.'
        : `Upload failed: ${upErr.message}` },
      { status: 500 },
    );
  }

  const name = String(form.get('name') || file.name.replace(/\.[^.]+$/, '')).trim().slice(0, 300);
  const category = String(form.get('category') || (auto ? classified.category : '') || '').trim().slice(0, 60);
  const tags = auto ? formatAdTags(parseAdTags(classified.tags.join(', '))) : '';
  const row = {
    name: name || 'Ad template',
    ad_type: resolved.value,
    category,
    media_type: inferred.media,
    file_path: path,
    tags,
    headline: '',
    primary_text: '',
    owner_user_id: userId,
  };

  const { data, error } = await supabaseAdmin
    .from('archive_ads')
    .insert(row)
    .select()
    .single();

  if (error || !data) {
    await supabaseAdmin.storage.from(BUCKET).remove([path]).catch(() => {});
    if (isMissingAdTypesTable(error?.message)) {
      return NextResponse.json(
        { error: 'Ads library tables are missing. Run supabase-migration-archive-ads.sql on Supabase.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: error?.message || 'Could not save ad' }, { status: 500 });
  }

  return NextResponse.json(data);
}
