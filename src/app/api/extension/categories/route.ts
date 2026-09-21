import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * User-defined archive categories (niches: "Survival", "Weight loss", …).
 * Shared between the app's My Archive view and the browser extension.
 * Team library: every master/user sees the same list.
 *
 * GET    → { categories: string[] }  (known categories + any used on saves)
 * POST   → { name }  create a category
 * DELETE → ?name=... remove a category (only from the known list)
 */

function isMissingTable(msg?: string): boolean {
  return /archive_categories|relation .* does not exist|does not exist/i.test(msg || '');
}

// Funnel-walk saves store the funnel DOMAIN in `category` (used only to group
// the folder). Domains must never show up in the niche Category picker.
const isDomainLike = (s: string) => !/\s/.test(s) && /\.[a-z]{2,}$/i.test(s.trim());

async function knownCategories(): Promise<string[]> {
  const set = new Set<string>();
  try {
    const { data, error } = await supabaseAdmin
      .from('archive_categories')
      .select('name');
    if (!error) for (const r of data || []) if (r.name && !isDomainLike(String(r.name))) set.add(String(r.name));
  } catch {
    /* table may not exist yet */
  }
  try {
    const { data } = await supabaseAdmin
      .from('archived_funnels')
      .select('list_category')
      .is('project_id', null)
      .not('list_category', 'is', null);
    for (const f of data || []) {
      const c = String((f as { list_category?: string }).list_category || '').trim();
      if (c && !isDomainLike(c)) set.add(c);
    }
  } catch {
    /* list_category may not exist yet */
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ success: true, categories: await knownCategories() });
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || '').trim().slice(0, 60);
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  let persisted = true;
  const { error } = await supabaseAdmin
    .from('archive_categories')
    .upsert({ name, owner_user_id: userId }, { onConflict: 'owner_user_id,name' });
  if (error) {
    if (isMissingTable(error.message)) persisted = false;
    else return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    persisted,
    name,
    categories: await knownCategories(),
  });
}

export async function DELETE(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const name = req.nextUrl.searchParams.get('name') || '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  try {
    await supabaseAdmin
      .from('archive_categories')
      .delete()
      .eq('name', name);
  } catch {
    /* ignore */
  }
  return NextResponse.json({ success: true, categories: await knownCategories() });
}
