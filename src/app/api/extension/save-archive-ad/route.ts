import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { extForContentType, mediaTypeForContentType } from '@/lib/competitor-ads';
import { isMissingAdTypesTable, resolveAdType, upsertArchiveAdType } from '@/lib/archive-ad-types';
import { formatAdTags, parseAdTags } from '@/lib/ad-tags';
import {
  classifyArchiveAd,
  parseSourceFingerprintFromTags,
  sourceFingerprint,
  sourceTag,
} from '@/lib/classify-archive-ad';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BUCKET = 'project-files';
const MAX_SIZE = 40 * 1024 * 1024;

interface Body {
  mediaUrl?: string;
  mediaBase64?: string;
  storagePath?: string;
  contentType?: string;
  mediaType?: 'image' | 'video' | string;
  name?: string;
  headline?: string;
  primaryText?: string;
  primary_text?: string;
  width?: number;
  height?: number;
  pageUrl?: string;
  pageTitle?: string;
  category?: string;
  extraTags?: string[];
  tags?: string[];
  adType?: string;
  carousel?: boolean;
}

function decodeBase64(input: string): { buffer: Buffer; contentType: string } | null {
  const m = input.match(/^data:([^;]+);base64,(.*)$/i);
  const base64 = m ? m[2] : input;
  const contentType = m ? m[1] : 'application/octet-stream';
  try {
    const buffer = Buffer.from(base64, 'base64');
    return buffer.length > 0 ? { buffer, contentType } : null;
  } catch {
    return null;
  }
}

async function fetchMedia(
  url: string,
  referer: string,
  timeoutMs: number,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: referer || url,
        Accept: '*/*',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    return buffer.length > 0 ? { buffer, contentType } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function alreadySaved(userId: string, fp: string): Promise<boolean> {
  if (!fp) return false;
  const { data, error } = await supabaseAdmin
    .from('archive_ads')
    .select('id, tags')
    .eq('owner_user_id', userId)
    .ilike('tags', `%src:${fp}%`)
    .limit(8);
  if (error || !data) return false;
  return data.some((row) => parseSourceFingerprintFromTags(String(row.tags || '')) === fp);
}

/**
 * POST /api/extension/save-archive-ad
 *
 * Save one creative into Template → Ads, auto-classified into
 * Image / Video / Carousel / UGC / Story. Duplicates (same media URL) skip.
 */
export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Connect the extension to your account first.' },
      { status: 401 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  const mediaUrl = String(body.mediaUrl || '').trim();
  let storagePath = String(body.storagePath || '').trim();
  if (storagePath && !storagePath.startsWith(`archive-ads/${userId}/`)) storagePath = '';
  if (!mediaUrl && !body.mediaBase64 && !storagePath) {
    return NextResponse.json({ error: 'mediaUrl, mediaBase64 or storagePath is required' }, { status: 400 });
  }

  const fp = mediaUrl ? sourceFingerprint(mediaUrl) : '';
  if (fp && (await alreadySaved(userId, fp))) {
    return NextResponse.json({ success: true, skipped: true, duplicate: true, fingerprint: fp });
  }

  let buffer: Buffer | null = null;
  let contentType = String(body.contentType || '').trim();

  if (body.mediaBase64) {
    const decoded = decodeBase64(body.mediaBase64);
    if (decoded) {
      buffer = decoded.buffer;
      if (!contentType) contentType = decoded.contentType;
    }
  }

  if (!buffer && !storagePath && mediaUrl && /^https?:\/\//i.test(mediaUrl)) {
    const pageUrl = String(body.pageUrl || mediaUrl);
    const timeout = body.mediaType === 'video' ? 45000 : 18000;
    const referers = [pageUrl, 'https://www.facebook.com/', 'https://adspends.com/', mediaUrl];
    for (const referer of referers) {
      const fetched = await fetchMedia(mediaUrl, referer, timeout);
      if (fetched && fetched.buffer.length > 80) {
        buffer = fetched.buffer;
        if (!contentType) contentType = fetched.contentType;
        break;
      }
    }
  }

  if (buffer && buffer.length > MAX_SIZE) {
    return NextResponse.json({ error: `File too large (max ${MAX_SIZE / 1024 / 1024}MB)` }, { status: 413 });
  }

  if (!buffer && !storagePath) {
    return NextResponse.json(
      { error: 'Could not download this creative (CDN blocked). Try hover-Save or a smaller clip.' },
      { status: 422 },
    );
  }

  const inferredMedia = contentType
    ? mediaTypeForContentType(contentType)
    : body.mediaType === 'video'
      ? 'video'
      : 'image';

  const classified = classifyArchiveAd({
    mediaType: inferredMedia,
    width: Number(body.width) || 0,
    height: Number(body.height) || 0,
    name: String(body.name || ''),
    text: String(body.primaryText || body.primary_text || ''),
    headline: String(body.headline || ''),
    pageUrl: String(body.pageUrl || ''),
    pageTitle: String(body.pageTitle || ''),
    carousel: Boolean(body.carousel),
  });

  const forced = String(body.adType || '').trim();
  const resolved = resolveAdType(forced && forced !== 'auto' ? forced : classified.ad_type, '');
  if (resolved.isCustom) {
    await upsertArchiveAdType(userId, resolved.value, resolved.label);
  }

  const category = String(body.category || classified.category || '').trim().slice(0, 60);
  const extra = [
    fp ? sourceTag(mediaUrl) : '',
    ...classified.tags,
    ...(Array.isArray(body.extraTags) ? body.extraTags : []),
    ...(Array.isArray(body.tags) ? body.tags : []),
  ];
  const tags = formatAdTags(parseAdTags(extra.filter(Boolean).join(', ')));

  if (buffer && !storagePath) {
    const ext = extForContentType(contentType || 'application/octet-stream', inferredMedia === 'video' ? 'mp4' : 'jpg');
    const rand = Math.random().toString(36).slice(2, 8);
    storagePath = `archive-ads/${userId}/${Date.now()}_${rand}.${ext}`;
    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: contentType || (inferredMedia === 'video' ? 'video/mp4' : 'image/jpeg'),
      upsert: false,
    });
    if (upErr) {
      return NextResponse.json(
        {
          error: upErr.message.includes('Bucket not found')
            ? 'Storage bucket "project-files" not found. Create it in Supabase → Storage.'
            : `Upload failed: ${upErr.message}`,
        },
        { status: 500 },
      );
    }
  }

  const name = String(body.name || body.headline || 'AdSpends ad').trim().slice(0, 300) || 'Ad template';
  const row = {
    name,
    ad_type: resolved.value,
    category,
    media_type: classified.media_type,
    file_path: storagePath,
    tags,
    headline: String(body.headline || '').trim().slice(0, 500),
    primary_text: String(body.primaryText || body.primary_text || '').trim().slice(0, 4000),
    owner_user_id: userId,
  };

  const { data, error } = await supabaseAdmin.from('archive_ads').insert(row).select().single();
  if (error || !data) {
    if (storagePath) await supabaseAdmin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    if (isMissingAdTypesTable(error?.message)) {
      return NextResponse.json(
        { error: 'Ads library tables are missing. Run supabase-migration-archive-ads.sql on Supabase.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: error?.message || 'Could not save ad' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    ad: data,
    ad_type: resolved.value,
    category,
    fingerprint: fp,
  });
}
