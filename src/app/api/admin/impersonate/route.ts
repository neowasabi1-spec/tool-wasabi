/**
 * Master-only impersonation: mint a REAL Supabase session for a target user.
 *
 * Why a real session (token swap) instead of just a header
 * ────────────────────────────────────────────────────────
 * The browser's Supabase client splices `wasabi_session.access_token` into
 * EVERY `supabase.from(...)` call (see src/lib/supabase.ts), and most data
 * (projects, funnels, …) is read directly from Supabase under RLS — NOT via
 * our /api routes. A request header therefore can't change what those direct
 * reads return; only the JWT's `auth.uid()` can. So to truly "see what the
 * user sees", the master's browser must temporarily hold a session that
 * belongs to the target user.
 *
 * We generate that session here with the service role:
 *   1. requireMaster — only a master may call this.
 *   2. generateLink(magiclink) for the target's email → a one-time token_hash.
 *   3. verifyOtp(token_hash) on an anon client → a real { access_token,
 *      refresh_token } session for the target user.
 *
 * The client stores it as the active `wasabi_session` (backing up the
 * master's own session) so both direct Supabase reads and /api routes act as
 * the target. Exiting restores the master session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireMaster } from '@/lib/auth/server-guard';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const auth = await requireMaster(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const targetUserId = typeof body?.targetUserId === 'string' ? body.targetUserId : '';
  if (!targetUserId) {
    return NextResponse.json({ error: 'targetUserId is required' }, { status: 400 });
  }
  if (targetUserId === auth.user.id) {
    return NextResponse.json({ error: 'You cannot impersonate yourself' }, { status: 400 });
  }

  // Resolve the target's email (needed to generate the magic link).
  const { data: targetData, error: targetErr } =
    await supabaseAdmin.auth.admin.getUserById(targetUserId);
  const email = targetData?.user?.email;
  if (targetErr || !email) {
    return NextResponse.json({ error: 'Target user not found' }, { status: 404 });
  }

  // Generate a one-time magic-link token for that user (no email is sent —
  // generateLink just returns the token to us).
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    return NextResponse.json(
      { error: `Could not generate impersonation token: ${linkErr?.message || 'no token_hash'}` },
      { status: 500 },
    );
  }

  // Exchange the token for a real session on an anon client.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: otpData, error: otpErr } = await anon.auth.verifyOtp({
    type: 'magiclink',
    token_hash: tokenHash,
  });
  const session = otpData?.session;
  if (otpErr || !session?.access_token || !session?.refresh_token) {
    return NextResponse.json(
      { error: `Could not establish impersonation session: ${otpErr?.message || 'no session'}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    email,
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      user_id: targetUserId,
      email,
      expires_at: session.expires_at,
    },
  });
}
