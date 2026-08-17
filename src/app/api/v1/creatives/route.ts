import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  ensureBrand,
  brandNameFromUrl,
  insertCompetitorAd,
  mediaTypeForContentType,
} from '@/lib/competitor-ads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Competitor creatives over the fsk_-key API, so MCP clients (Neo/Morfeo) can
 * save/list competitor ads exactly like the browser extension — rows land in
 * the same competitor_ads table the Project Hub reads (auto-splits videos into
 * shots on insert).
 *
 *   GET  /api/v1/creatives?projectId=…[&brandId=…]  → list creatives
 *   POST /api/v1/creatives                          → save a creative from a URL
 */

async function fetchMedia(
  url: string,
  referer: string,
  timeoutMs = 45000,
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

function contentTypeFromUrl(url: string, hint?: 'image' | 'video'): string {
  if (hint === 'video') return 'video/mp4';
  if (/\.(mp4|webm|mov|ogv)(\?|$)/i.test(url)) return 'video/mp4';
  if (/\.(png)(\?|$)/i.test(url)) return 'image/png';
  if (/\.(webp)(\?|$)/i.test(url)) return 'image/webp';
  if (/\.(gif)(\?|$)/i.test(url)) return 'image/gif';
  return 'image/jpeg';
}

export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req, 'read_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const projectId = req.nextUrl.searchParams.get('projectId')?.trim() || '';
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  const brandId = Number(req.nextUrl.searchParams.get('brandId'));

  let q = supabaseAdmin
    .from('competitor_ads')
    .select('id, project_id, brand_id, media_type, file_path, name, headline, hook, body_text, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (Number.isFinite(brandId) && brandId > 0) q = q.eq('brand_id', brandId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ creatives: data || [], count: data?.length || 0 });
}

export async function POST(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const projectId = String(body.projectId || body.project_id || '').trim();
  const mediaUrl = String(body.mediaUrl || body.media_url || '').trim();
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  if (!/^https?:\/\//i.test(mediaUrl)) {
    return NextResponse.json({ error: 'mediaUrl (http/https) is required' }, { status: 400 });
  }

  const pageUrl = String(body.pageUrl || body.page_url || '').trim();
  const mediaHint = body.mediaType === 'video' ? 'video' : body.mediaType === 'image' ? 'image' : undefined;

  // Fetch the bytes server-side (with a browser-like UA + Referer).
  let buffer: Buffer | null = null;
  let contentType = String(body.contentType || '').trim();
  const fetched = await fetchMedia(mediaUrl, pageUrl, mediaHint === 'video' ? 45000 : 15000);
  if (fetched) {
    buffer = fetched.buffer;
    if (!contentType) contentType = fetched.contentType;
  }
  if (!contentType) contentType = contentTypeFromUrl(mediaUrl, mediaHint);
  if (mediaHint === 'video' && !/^video\//i.test(contentType)) contentType = 'video/mp4';

  const mediaType = mediaTypeForContentType(contentType);
  // A video with no downloadable bytes would be a dead card — refuse it.
  if (mediaType === 'video' && !buffer) {
    return NextResponse.json(
      { error: 'Could not download this video from the URL (blocked or streamed). Provide a direct CDN URL.' },
      { status: 422 },
    );
  }

  // Resolve the destination competitor: explicit brandId, else brandName, else
  // group by the source domain (page URL, falling back to the media URL host).
  let brandId: number | null = null;
  let brandName = '';
  const explicitId = Number(body.brandId ?? body.competitorId);
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
    let adsLibraryUrl = '';
    try {
      adsLibraryUrl = pageUrl ? new URL(pageUrl).origin : '';
    } catch {
      /* ignore */
    }
    brandName = String(body.brandName || '').trim() || brandNameFromUrl(pageUrl || mediaUrl);
    brandId = await ensureBrand(projectId, brandName, adsLibraryUrl);
  }
  if (!brandId) return NextResponse.json({ error: 'Could not create competitor brand' }, { status: 500 });

  const result = await insertCompetitorAd({
    projectId,
    brandId,
    buffer,
    contentType,
    remoteUrl: mediaUrl,
    meta: {
      name: String(body.name || body.pageTitle || brandName || '').slice(0, 300),
      headline: body.headline !== undefined ? String(body.headline) : undefined,
      hook: body.hook !== undefined ? String(body.hook) : undefined,
      body_text: body.bodyText !== undefined ? String(body.bodyText) : body.body_text !== undefined ? String(body.body_text) : undefined,
    },
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ success: true, projectId, brandId, brandName, mediaType, ad: result.ad });
}
