import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { PAGE_TYPE_OPTIONS } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns the archive "folders" for the extension popup. In this app the
 * archive (My Archive → "By Type") is organized by PAGE TYPE, not by projects,
 * so the folder dropdown offers the same page types (Advertorial, VSL,
 * Checkout, …). Also returns tag suggestions gathered from the user's projects.
 */
export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Connect the extension to your account first.' },
      { status: 401 },
    );
  }

  const folders = PAGE_TYPE_OPTIONS.map((o) => ({ id: o.value, name: o.label }));

  // Tag suggestions from the user's projects (best-effort).
  const tagSet = new Set<string>();
  try {
    const { data } = await supabaseAdmin
      .from('projects')
      .select('tags')
      .eq('owner_user_id', userId);
    for (const p of data || []) {
      const tags = (p as { tags?: unknown }).tags;
      if (Array.isArray(tags)) tags.forEach((t) => t && tagSet.add(String(t)));
    }
  } catch {
    /* ignore */
  }

  // Known categories (niches) — ONLY the ones the user builds with the "+"
  // button, i.e. rows in `archive_categories`. We deliberately do NOT derive
  // categories from saved pages' step data: funnel walks store the domain as
  // the step category (for folder grouping), which would otherwise flood this
  // list with domains / funnel / landing names. Domain-like names are filtered
  // out too, so any legacy pollution never surfaces in the picker.
  const isDomainLike = (s: string) => !/\s/.test(s) && /\.[a-z]{2,}$/i.test(s.trim());
  const catSet = new Set<string>();
  try {
    const { data } = await supabaseAdmin
      .from('archive_categories')
      .select('name')
      .eq('owner_user_id', userId);
    for (const c of data || []) {
      const name = c.name ? String(c.name) : '';
      if (name && !isDomainLike(name)) catSet.add(name);
    }
  } catch {
    /* table may not exist yet */
  }

  return NextResponse.json({
    success: true,
    folders,
    tags: Array.from(tagSet).sort(),
    categories: Array.from(catSet).sort((a, b) => a.localeCompare(b)),
  });
}
