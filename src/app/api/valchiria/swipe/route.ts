import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * POST /api/valchiria/swipe
 * Carica gli step di funnel archiviati come funnel_pages per il prodotto target.
 * Body: { funnelIds: string[], productId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const { funnelIds, productId } = await req.json();

    if (!funnelIds || !Array.isArray(funnelIds) || funnelIds.length === 0) {
      return NextResponse.json({ error: 'funnelIds required' }, { status: 400 });
    }
    if (!productId) {
      return NextResponse.json({ error: 'productId required' }, { status: 400 });
    }

    // 1. Leggi i funnel archiviati con i loro step
    const { data: funnels, error: fetchError } = await supabase
      .from('archived_funnels')
      .select('id, name, steps, total_steps')
      .in('id', funnelIds);

    if (fetchError) throw fetchError;
    if (!funnels || funnels.length === 0) {
      return NextResponse.json({ error: 'No funnels found' }, { status: 404 });
    }

    // 2. Cancella le funnel_pages esistenti
    const { data: existingPages } = await supabase
      .from('funnel_pages')
      .select('id');

    if (existingPages && existingPages.length > 0) {
      const { error: deleteError } = await supabase
        .from('funnel_pages')
        .delete()
        .in('id', existingPages.map((p: { id: string }) => p.id));
      if (deleteError) throw deleteError;
    }

    // 3. Crea le nuove funnel_pages dagli step
    const pagesToCreate = [];
    for (const funnel of funnels) {
      const steps = (funnel.steps as {
        step_index: number;
        name: string;
        url_to_swipe: string;
        page_type: string;
        prompt: string;
      }[]) || [];

      for (const step of steps) {
        pagesToCreate.push({
          name: step.name || `Step ${step.step_index}`,
          page_type: step.page_type || 'landing',
          product_id: productId,
          url_to_swipe: step.url_to_swipe || '',
          prompt: step.prompt || '',
          swipe_status: 'pending',
        });
      }
    }

    if (pagesToCreate.length === 0) {
      return NextResponse.json({ error: 'No steps found in selected funnels' }, { status: 400 });
    }

    // 4. Inserisci in batch
    const { data: created, error: insertError } = await supabase
      .from('funnel_pages')
      .insert(pagesToCreate)
      .select();

    if (insertError) throw insertError;

    return NextResponse.json({
      success: true,
      created: created?.length || 0,
      redirectTo: '/front-end-funnel',
      message: `${created?.length} step caricati per prodotto ${productId}`,
    });

  } catch (error) {
    console.error('Valchiria swipe error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/valchiria/swipe
 * Ritorna i funnel [SWIPE] disponibili con i loro step
 */
export async function GET() {
  try {
    const { data: funnels, error } = await supabase
      .from('archived_funnels')
      .select('id, name, steps, total_steps, created_at')
      .ilike('name', '%[SWIPE]%')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ funnels: funnels || [] });
  } catch (error) {
    console.error('Valchiria GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
