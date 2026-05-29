import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

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

  const { error } = await supabaseAdmin
    .from('page_html')
    .upsert(
      {
        page_id: pageId,
        kind,
        variant,
        html,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'page_id,kind,variant' },
    );

  if (error) {
    if (isMissingTable(error.message)) {
      return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
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

  const { data, error } = await supabaseAdmin
    .from('page_html')
    .select('html')
    .eq('page_id', pageId)
    .eq('kind', kind)
    .eq('variant', variant)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error.message)) {
      return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data?.html) {
    return new NextResponse('', { status: 404 });
  }

  return new NextResponse(data.html as string, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
