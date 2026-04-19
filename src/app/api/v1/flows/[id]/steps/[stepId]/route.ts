import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; stepId: string }> }) {
  const { stepId } = await params;
  const { data, error } = await supabase.from('flow_steps').select('*').eq('id', stepId).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ step: data });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; stepId: string }> }) {
  const { stepId } = await params;
  const body = await req.json();
  const { id: _id, ...updates } = body;
  const { data, error } = await supabase
    .from('flow_steps')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', stepId)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ step: data });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; stepId: string }> }) {
  const { stepId } = await params;
  const { error } = await supabase.from('flow_steps').delete().eq('id', stepId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
