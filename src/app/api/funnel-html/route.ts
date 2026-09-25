import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { persistPageHtml, readPageHtml } from '@/lib/page-html-persist';

export const dynamic = 'force-dynamic';

const MIGRATION_HINT =
  'Migration non eseguita — lancia supabase-migration-page-html.sql (tabella page_html)';

const KINDS = new Set(['cloned', 'swiped', 'extracted']);
const VARIANTS = new Set(['desktop', 'mobile']);

function isMissingTable(message?: string): boolean {
  return /page_html|does not exist|relation .* does not exist/i.test(message || '');
}

/**
 * Salva l'HTML pesante di una funnel page nella tabella `page_html` usando il
 * service role (bypassa RLS). Ritorna una URL GET che la rehydrate/anteprima
 * usano per rileggere l'HTML — sostituisce il vecchio upload su Storage.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const pageId = typeof body?.pageId === 'string' ? body.pageId : '';
  const kind = typeof body?.kind === 'string' ? body.kind : '';
  const variant =
    typeof body?.variant === 'string' && VARIANTS.has(body.variant)
      ? body.variant
      : 'desktop';
  const html = typeof body?.html === 'string' ? body.html : '';

  if (!pageId || !KINDS.has(kind) || !html) {
    return NextResponse.json(
      { error: 'pageId, kind (cloned|swiped|extracted) e html sono obbligatori' },
      { status: 400 },
    );
  }

  // Multi-tenancy: tag the page-html row with the caller so the master
  // can audit per-user storage. If no JWT is present (worker / cron /
  // unauthenticated) we fall back to the DB trigger, which assigns the
  // master account.
  const userId = await getCurrentUserId(req);
  try {
    await persistPageHtml(supabaseAdmin, {
      pageId,
      kind: kind as 'cloned' | 'swiped' | 'extracted',
      variant,
      html,
      ownerUserId: userId,
    });
  } catch (e) {
    const message = (e as Error).message || 'save failed';
    if (isMissingTable(message)) {
      return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const url =
    `/api/funnel-html?pageId=${encodeURIComponent(pageId)}` +
    `&kind=${encodeURIComponent(kind)}` +
    `&variant=${encodeURIComponent(variant)}` +
    `&v=${Date.now()}`;
  return NextResponse.json({ url });
}

/**
 * Rilegge l'HTML salvato. Ritorna il body come text/html: il chiamante fa
 * sempre `.text()`, quindi il content-type non e' vincolante.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const pageId = sp.get('pageId') || '';
  const kind = sp.get('kind') || '';
  const variant = sp.get('variant') || 'desktop';

  if (!pageId || !KINDS.has(kind)) {
    return NextResponse.json({ error: 'pageId e kind obbligatori' }, { status: 400 });
  }

  const load = async (v: string) => {
    try {
      const html = await readPageHtml(
        supabaseAdmin,
        pageId,
        kind as 'cloned' | 'swiped' | 'extracted',
        v,
      );
      return { html, error: null as string | null };
    } catch (e) {
      return { html: '', error: (e as Error).message };
    }
  };

  let { html, error } = await load(variant);
  // Chimera / Clone-Swipe persist desktop only. Mobile preview uses that HTML
  // (the template is already responsive) instead of a hard 404.
  if (!error && !html && variant === 'mobile') {
    const fallback = await load('desktop');
    html = fallback.html;
    error = fallback.error;
  }

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });
    }
    return NextResponse.json({ error }, { status: 500 });
  }

  if (!html) {
    return new NextResponse('', { status: 404 });
  }

  if (sp.get('inert') === '1') {
    html = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<script\b[^>]*\/?>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/<meta[^>]+http-equiv=["']?refresh["'][^>]*>/gi, '');
  }

  let updatedAt = '';
  try {
    const { data } = await supabaseAdmin
      .from('page_html')
      .select('updated_at')
      .eq('page_id', pageId)
      .eq('kind', kind)
      .eq('variant', variant === 'mobile' && !html ? 'desktop' : variant)
      .maybeSingle();
    if (data?.updated_at) updatedAt = String(data.updated_at);
  } catch { /* header is optional */ }

  return new NextResponse(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...(updatedAt ? { 'x-html-updated-at': updatedAt } : {}),
    },
  });
}
