import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';

/**
 * GET /api/templates — shared swipe-template catalog.
 *
 * Why this exists: swipe_templates is a SHARED library (the quiz/funnel
 * templates everyone swipes from), but the multi-tenancy RLS SELECT
 * policy restricts rows to the owner. Every existing template is owned
 * by the master, so a regular user only saw the handful they created
 * (e.g. 4) while the master saw all of them (e.g. 19) when adding a
 * step / picking a template.
 *
 * Reading through supabaseAdmin (service role) bypasses RLS so every
 * authenticated user gets the full catalog — no manual SQL migration
 * required. Mutations still go through the RLS-protected client
 * elsewhere, so users still can't edit/delete templates they don't own.
 *
 * Requires a logged-in user (the global fetch interceptor attaches the
 * JWT to /api/* calls); anonymous callers get an empty list.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { userId } = await getUserAccessContext(req);
  if (!userId) {
    // No session → return empty rather than leaking the whole catalog
    // to unauthenticated callers.
    return NextResponse.json([], { headers: { 'Cache-Control': 'no-store' } });
  }

  const { data, error } = await supabaseAdmin
    .from('swipe_templates')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[api/templates] fetch failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? [], { headers: { 'Cache-Control': 'no-store' } });
}
