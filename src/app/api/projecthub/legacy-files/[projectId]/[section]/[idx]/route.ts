import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { resolveLegacyFile, type LegacySection } from '@/lib/projecthub-legacy';

export const dynamic = 'force-dynamic';

const VALID_SECTIONS: LegacySection[] = [
  'market_research',
  'brief_files',
  'front_end',
  'back_end',
  'compliance_funnel',
  'funnel',
];

const LEGACY_COLS =
  'id, market_research, brief_files, front_end, back_end, compliance_funnel, funnel';

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: { projectId: string; section: string; idx: string };
  },
) {
  const section = params.section as LegacySection;
  if (!VALID_SECTIONS.includes(section)) {
    return NextResponse.json({ error: 'Invalid legacy section' }, { status: 400 });
  }
  const idx = Number(params.idx);
  if (!Number.isFinite(idx) || idx < 0) {
    return NextResponse.json({ error: 'Invalid file index' }, { status: 400 });
  }

  const { data: project, error } = await supabase
    .from('projects')
    .select(LEGACY_COLS)
    .eq('id', params.projectId)
    .single();

  if (error || !project) {
    return NextResponse.json(
      { error: error?.message || 'Project not found' },
      { status: 404 },
    );
  }

  const file = resolveLegacyFile(project as Record<string, unknown>, section, idx);
  if (!file) {
    return NextResponse.json({ error: 'Legacy file not found' }, { status: 404 });
  }

  const safeName = (file.name || `legacy_${section}_${idx + 1}.txt`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const contentType = file.type || 'text/plain; charset=utf-8';
  const body = file.content || '';

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': contentType.startsWith('text/') ? contentType : 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
