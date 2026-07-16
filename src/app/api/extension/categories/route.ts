import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * User-defined archive categories (niches: "Survival", "Weight loss", …).
 * Shared between the app's My Archive view and the browser extension.
 *
 * GET    → { categories: string[] }  (known categories + any used on saves)
 * POST   → { name }  create a category
 * DELETE → ?name=... remove a category (only from the known list)
 */

function isMissingTable(msg?: string): boolean {
  return /archive_categories|relation .* does not exist|does not exist/i.test(msg || '');
}

async function knownCategories(userId: string): Promise<string[]> {
  const set = new Set<string>();
  // 1) explicit list (table)
  try {
    const { data, error } = await supabaseAdmin
      .from('archive_categories')
      .select('name')
      .eq('owner_user_id', userId);
    if (!error) for (const r of data || []) if (r.name) set.add(String(r.name));
  } catch {
    /* table may not exist yet */
  }
  // 2) categories actually used on the user's saved pages
  try {
    const { data } = await supabaseAdmin
      .from('archived_funnels')
      .select('steps')
      .eq('owner_user_id', userId);
    for (const f of data || []) {
      const steps = Array.isArray(f.steps) ? (f.steps as Record<string, unknown>[]) : [];
      for (const s of steps) {
        const c = (s.category as string) || ((s.cloned_data as Record<string, unknown>)?.category as string);
        if (c) set.add(String(c));
      }
    }
  } catch {
    /* ignore */
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ success: true, categories: await knownCategories(userId) });
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
    categories: await knownCategories(userId),
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
      .eq('owner_user_id', userId)
      .eq('name', name);
  } catch {
    /* ignore */
  }
  return NextResponse.json({ success: true, categories: await knownCategories(userId) });
}
