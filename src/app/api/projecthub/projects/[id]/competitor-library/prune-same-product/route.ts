import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { pruneNonSameProductBrands } from '@/lib/competitor-same-product';
import { loadDiscoveryLexicon } from '@/lib/discovery-lexicon';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST — drop competitor pages that are not this offer.
 * Unreadable scrapes (bot walls, empty copy) are removed without a model call.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const lexicon = await loadDiscoveryLexicon(supabaseAdmin, projectId);
    const product = lexicon.product;
    let profile: { name: string; description?: string; market?: string; hosts?: string[]; names?: string[] } | null = null;
    if (product?.name) {
      profile = {
        name: product.name,
        description: product.description || '',
        market: product.market || '',
        hosts: product.hosts || [],
        names: product.names?.length ? product.names : [product.name],
      };
    } else {
      const { data: project } = await supabaseAdmin
        .from('projects')
        .select('name, description')
        .eq('id', projectId)
        .maybeSingle();
      if (project?.name) {
        profile = {
          name: String(project.name),
          description: String(project.description || '').slice(0, 900),
          names: [String(project.name)],
        };
      }
    }
    if (!profile) return NextResponse.json({ ok: true, checked: 0, removed: 0, kept: 0 });

    const result = await pruneNonSameProductBrands(projectId, {
      ...profile,
      affiliate: true,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Prune failed' },
      { status: 500 },
    );
  }
}
