import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserAccessContext } from '@/lib/auth/get-current-user';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

/**
 * GET /api/projects/list
 *
 * Lista snella dei progetti per il selettore di /clone-landing (e altri
 * punti del tool che vogliono offrire una scelta di progetto). Ritorniamo
 * solo i campi che servono al picker (id, name, description, brief), non
 * il payload pesante (market_research JSON, funnel, ecc.) — quello arriva
 * solo quando viene effettivamente usato via /api/swipe/load-knowledge.
 *
 * Multi-tenancy: a regular user sees only projects they own; the master
 * sees everything. Unauthenticated callers (no JWT) get the legacy
 * "see all" behaviour for now (phase-2 RLS lockdown will block them).
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getUserAccessContext(req);
    let query = supabase
      .from('projects')
      .select('id, name, description, brief, status')
      .order('updated_at', { ascending: false });
    if (ctx.userId && !ctx.isMaster) {
      query = query.eq('owner_user_id', ctx.userId);
    }
    const { data, error } = await query;
    if (error) throw error;
    const projects = (data || []).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      brief: p.brief ?? null,
      status: p.status ?? null,
    }));
    return NextResponse.json({ success: true, projects });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        projects: [],
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
