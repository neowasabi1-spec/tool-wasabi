import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    const { funnel_id, analysis } = await request.json();

    if (!funnel_id || !analysis) {
      return NextResponse.json({ error: 'funnel_id and analysis are required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('archived_funnels')
      .update({ analysis })
      .eq('id', funnel_id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error saving funnel analysis:', error);
    return NextResponse.json({ error: 'Failed to save analysis' }, { status: 500 });
  }
}
