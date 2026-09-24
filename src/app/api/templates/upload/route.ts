import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { fetchHtmlSmart } from '@/lib/fetch-html-smart';
import { absolutizeUrlsInHtml } from '@/lib/spa-rescue';
import { persistPageHtml } from '@/lib/page-html-persist';
import { resolvePageType, upsertArchivePageType } from '@/lib/archive-page-types';
import { inferPageGeo } from '@/lib/page-geo';
import { inferPageTags } from '@/lib/page-niche-tags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function siteBaseUrl(): string {
  return (
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    ''
  ).replace(/\/$/, '');
}

function webhookSecret(): string {
  return process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
}

/**
 * Manual template upload (Templates → By Type folder).
 *
 * Same persistence as the Wasabi Saver extension:
 *   archived_funnels row (section=page) + page_html snapshot +
 *   desktop/mobile screenshots (background Playwright, extension viewports).
 *
 * Body: { url?: string, html?: string, name?: string, pageType: string, category?: string }
 */
interface UploadBody {
  url?: string;
  html?: string;
  name?: string;
  pageType?: string;
  pageTypeLabel?: string;
  category?: string;
}

function titleFromHtml(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return (m ? m[1] : '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function guessNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'Uploaded page';
  } catch {
    return 'Uploaded page';
  }
}

async function triggerShots(funnelId: string, origin: string): Promise<void> {
  const base = (siteBaseUrl() || origin || '').replace(/\/$/, '');
  if (!base) return;
  const secret = webhookSecret();
  try {
    await fetch(`${base}/.netlify/functions/competitor-shots-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ funnelId, secret }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* background may still have been queued */
  }
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) {
    return NextResponse.json({ error: 'Sign in to upload a template.' }, { status: 401 });
  }

  let body: UploadBody;
  try {
    body = (await req.json()) as UploadBody;
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  const rawUrl = String(body.url || '').trim();
  let html = String(body.html || '').trim();
  const requestedType = String(body.pageType || '').trim();
  if (!requestedType) {
    return NextResponse.json({ error: 'pageType is required' }, { status: 400 });
  }

  let url = rawUrl;
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (url) {
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }
  }

  if (!html && !url) {
    return NextResponse.json({ error: 'Provide a page URL or HTML.' }, { status: 400 });
  }

  if (!html && url) {
    const fetched = await fetchHtmlSmart(url, {
      fetchTimeoutMs: 18_000,
      playwrightTimeoutMs: 28_000,
    });
    html = fetched.html || '';
    if (!html || html.length < 30) {
      return NextResponse.json(
        { error: fetched.error || 'Could not download the page HTML from that URL.' },
        { status: 422 },
      );
    }
  }

  if (!html || html.length < 30) {
    return NextResponse.json({ error: 'HTML is too short to save as a template.' }, { status: 400 });
  }

  if (!url) {
    const canon =
      html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      '';
    url = /^https?:\/\//i.test(canon) ? canon : `https://manual-upload.local/${randomUUID()}`;
  }

  try {
    html = absolutizeUrlsInHtml(html, url);
  } catch {
    /* keep raw */
  }
  html = html.slice(0, 4_000_000);

  const resolvedType = resolvePageType(requestedType, body.pageTypeLabel);
  const pageType = resolvedType.value;
  const category = String(body.category || '').trim().slice(0, 60);
  const name =
    String(body.name || '').trim().slice(0, 120) ||
    titleFromHtml(html) ||
    guessNameFromUrl(url);

  if (resolvedType.isCustom) {
    try {
      await upsertArchivePageType(userId, resolvedType.value, resolvedType.label);
    } catch {
      /* table may not exist yet */
    }
  }

  const { geo, lang } = inferPageGeo({ url, html, title: name });
  const clonedData: Record<string, unknown> = {
    title: name,
    source_url: url,
    method_used: 'manual-upload',
    cloned_at: new Date().toISOString(),
    category,
    tags: inferPageTags({ title: name, html }),
    geo,
    lang,
  };
  // Keep a small inline snapshot so the card can render before screenshots land.
  if (html.length <= 80_000) clonedData.html = html;

  const buildStep = (pageId: string, htmlUrl: string) => ({
    step_index: 1,
    name,
    page_type: pageType,
    category,
    template_name: '',
    product_name: '',
    url_to_swipe: url,
    prompt: '',
    feedback: '',
    swipe_status: 'completed',
    swipe_result: '',
    swiped_data: null,
    cloned_data: { ...clonedData, htmlUrl },
    page_id: pageId,
  });

  const { data: created, error: insertErr } = await supabaseAdmin
    .from('archived_funnels')
    .insert({
      name,
      total_steps: 1,
      steps: [buildStep('pending', '')],
      section: 'page',
      owner_user_id: userId,
    })
    .select('id')
    .single();

  if (insertErr || !created) {
    return NextResponse.json(
      { error: `Could not save template: ${insertErr?.message || 'unknown'}` },
      { status: 500 },
    );
  }

  const pageId: string = created.id;
  const htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(pageId)}&kind=cloned&variant=desktop&v=${Date.now()}`;
  await supabaseAdmin
    .from('archived_funnels')
    .update({ steps: [buildStep(pageId, htmlUrl)] })
    .eq('id', pageId);

  try {
    await persistPageHtml(supabaseAdmin, {
      pageId,
      kind: 'cloned',
      variant: 'desktop',
      html,
      ownerUserId: userId,
    });
  } catch (e) {
    console.warn('[templates/upload] page_html persist failed:', (e as Error).message);
  }

  const isDomainLike = (s: string) => !/\s/.test(s) && /\.[a-z]{2,}$/i.test(s.trim());
  if (category && !isDomainLike(category)) {
    try {
      await supabaseAdmin
        .from('archive_categories')
        .upsert({ name: category, owner_user_id: userId }, { onConflict: 'owner_user_id,name' });
    } catch {
      /* ignore */
    }
  }

  const origin = req.nextUrl?.origin || '';
  void triggerShots(pageId, origin);

  return NextResponse.json({
    success: true,
    pageId,
    pageType,
    name,
    category,
    htmlUrl,
    editorUrl: `/edit/${pageId}?src=${encodeURIComponent(url)}&title=${encodeURIComponent(name)}`,
  });
}
