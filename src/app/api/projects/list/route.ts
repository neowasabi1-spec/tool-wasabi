import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

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
 */
export async function GET() {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('id, name, description, brief, status')
      .order('updated_at', { ascending: false });
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
