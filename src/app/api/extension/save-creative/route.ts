import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { canAccessProject } from '@/lib/auth/project-access';
import {
  ensureBrand,
  brandNameFromUrl,
  insertCompetitorAd,
  mediaTypeForContentType,
} from '@/lib/competitor-ads';
import { transcribeVideo } from '@/lib/transcribe';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Save a single creative (image or video) captured from any web page by the
 * browser extension into the chosen project's Competitor Library.
 *
 * Creatives from the same source domain are grouped under one competitor
 * "brand" card (named after the page hostname). The extension may either send
 * the media bytes inline (base64 — used for blob: URLs) or just the absolute
 * mediaUrl, in which case we fetch it server-side. If we cannot download the
 * bytes we still record the ad pointing at the remote URL.
 *
 * Auth: per-user Supabase access token (Authorization: Bearer <token>).
 */

interface SaveCreativeBody {
  projectId?: string;
  pageUrl?: string;
  pageTitle?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video';
  mediaBase64?: string; // data URL or raw base64
  contentType?: string;
  name?: string;
  headline?: string;
  hook?: string;
  body_text?: string;
  brandId?: number | string; // save into an existing competitor
  brandName?: string; // create/reuse a competitor by name (overrides domain)
  autoScrape?: boolean; // enable daily monitoring on the destination competitor
  frequency?: string; // scrape cadence when autoScrape is on
  adsLibraryUrl?: string; // Meta Ad Library URL to monitor
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
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: referer || url,
        Accept: '*/*',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    return buffer.length > 0 ? { buffer, contentType } : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let body: SaveCreativeBody;
  try {
    body = (await req.json()) as SaveCreativeBody;
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  const userId = await getCurrentUserId(req);
  if (!userId) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Connect the extension to your account first.' },
      { status: 401 },
    );
  }

  const projectId = String(body.projectId || '').trim();
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) {
    return NextResponse.json(
      { error: 'forbidden', message: 'You do not have access to this project.' },
      { status: 403 },
    );
  }

  const pageUrl = String(body.pageUrl || '').trim();
  const mediaUrl = String(body.mediaUrl || '').trim();
  if (!mediaUrl && !body.mediaBase64) {
    return NextResponse.json({ error: 'mediaUrl or mediaBase64 is required' }, { status: 400 });
  }

  // Resolve the media bytes: inline base64 first, then server-side fetch.
  let buffer: Buffer | null = null;
  let contentType = String(body.contentType || '').trim();

  if (body.mediaBase64) {
    const decoded = decodeBase64(body.mediaBase64);
    if (decoded) {
      buffer = decoded.buffer;
      if (!contentType) contentType = decoded.contentType;
    }
  }
  if (!buffer && mediaUrl && /^https?:\/\//i.test(mediaUrl)) {
    const fetched = await fetchMedia(mediaUrl, pageUrl);
    if (fetched) {
      buffer = fetched.buffer;
      if (!contentType) contentType = fetched.contentType;
    }
  }

  // Derive a content type when still unknown (guides image/video + extension).
  if (!contentType) {
    if (body.mediaType === 'video') contentType = 'video/mp4';
    else if (/\.(mp4|webm|mov|ogv)(\?|$)/i.test(mediaUrl)) contentType = 'video/mp4';
    else if (/\.(png)(\?|$)/i.test(mediaUrl)) contentType = 'image/png';
    else if (/\.(webp)(\?|$)/i.test(mediaUrl)) contentType = 'image/webp';
    else if (/\.(gif)(\?|$)/i.test(mediaUrl)) contentType = 'image/gif';
    else contentType = 'image/jpeg';
  }
  // Honor an explicit mediaType hint over the sniffed content type.
  if (body.mediaType === 'video' && !/^video\//i.test(contentType)) contentType = 'video/mp4';

  let adsLibraryUrl = '';
  try {
    adsLibraryUrl = pageUrl ? new URL(pageUrl).origin : '';
  } catch {
    /* ignore */
  }

  // Resolve the destination competitor:
  //   explicit brandId → verify it belongs to the project;
  //   brandName override → find/create by that name;
  //   otherwise group by the page's domain (default).
  let brandId: number | null = null;
  let brandName = '';
  const explicitId = Number(body.brandId);
  if (Number.isFinite(explicitId) && explicitId > 0) {
    const { data: b } = await supabaseAdmin
      .from('competitor_brands')
      .select('id, name')
      .eq('id', explicitId)
      .eq('project_id', projectId)
      .maybeSingle();
    if (b?.id) {
      brandId = b.id as number;
      brandName = (b as { name?: string }).name || '';
    }
  }
  if (!brandId) {
    brandName = (body.brandName || '').trim() || brandNameFromUrl(pageUrl || mediaUrl);
    brandId = await ensureBrand(projectId, brandName, adsLibraryUrl);
  }
  if (!brandId) {
    return NextResponse.json({ error: 'Could not create competitor brand' }, { status: 500 });
  }

  // Apply auto-scraping config (from the extension) to the destination brand.
  const brandPatch: Record<string, unknown> = {};
  if (typeof body.adsLibraryUrl === 'string' && body.adsLibraryUrl.trim()) {
    brandPatch.ads_library_url = body.adsLibraryUrl.trim();
  }
  if (body.autoScrape) {
    brandPatch.frequency = (body.frequency || 'every_7_days').trim();
    brandPatch.is_active = 'true';
  }
  if (Object.keys(brandPatch).length > 0) {
    await supabaseAdmin
      .from('competitor_brands')
      .update(brandPatch)
      .eq('id', brandId)
      .eq('project_id', projectId);
  }

  // Auto-transcribe videos so the saved creative carries its script/copy.
  const mediaType = mediaTypeForContentType(contentType);
  let transcript = '';
  if (mediaType === 'video') {
    transcript = await transcribeVideo(buffer, contentType);
  }
  const bodyText = [body.body_text, transcript].filter(Boolean).join('\n\n').trim();

  const result = await insertCompetitorAd({
    projectId,
    brandId,
    buffer,
    contentType,
    remoteUrl: mediaUrl,
    meta: {
      name: body.name || body.pageTitle || brandName,
      headline: body.headline,
      hook: body.hook,
      body_text: bodyText,
    },
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });

  return NextResponse.json({
    success: true,
    projectId,
    brandId,
    brandName,
    mediaType,
    transcribed: !!transcript,
    ad: result.ad,
  });
}
