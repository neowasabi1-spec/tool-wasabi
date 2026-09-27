import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { normalizeBrandRules } from '@/lib/ads-intel/brain';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('name, brand_rules')
    .eq('id', id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Not found' }, { status: 404 });
  }

  return NextResponse.json({
    project_id: id,
    project_name: data.name,
    brand_rules: normalizeBrandRules(data.brand_rules),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const brand_rules = normalizeBrandRules(body.brand_rules ?? body);

  const { data, error } = await supabaseAdmin
    .from('projects')
    .update({
      brand_rules,
      tone: brand_rules.tone,
      positioning: brand_rules.positioning,
      palette: brand_rules.palette,
      logo_rules: brand_rules.logo_rules,
      logo_path: brand_rules.logo_path || null,
      forbidden: brand_rules.forbidden,
      required_elements: brand_rules.required_elements,
    })
    .eq('id', id)
    .select('name, brand_rules')
    .single();

  if (error || !data) {
    // Common local failure: migration not applied yet
    const msg = error?.message || 'Update failed';
    const hint = /brand_rules/i.test(msg)
      ? ' Apply supabase-migration-ads-intel.sql on your DEV Supabase project.'
      : '';
    return NextResponse.json({ error: msg + hint }, { status: 500 });
  }

  return NextResponse.json({
    project_id: id,
    project_name: data.name,
    brand_rules: normalizeBrandRules(data.brand_rules),
  });
}
