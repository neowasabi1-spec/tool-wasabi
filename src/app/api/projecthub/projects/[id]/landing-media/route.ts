import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import {
  extractLandingMediaForProject,
  listLandingMedia,
} from '@/lib/landing-media';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed, ctx } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  let items = await listLandingMedia(supabaseAdmin, id);
  if (!items.length) {
    try {
      await extractLandingMediaForProject(supabaseAdmin, id, ctx.userId);
      items = await listLandingMedia(supabaseAdmin, id);
    } catch (e) {
      console.warn('[landing-media] auto-extract:', (e as Error).message);
    }
  }
  return NextResponse.json(items);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed, ctx } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const result = await extractLandingMediaForProject(supabaseAdmin, id, ctx.userId);
    const items = await listLandingMedia(supabaseAdmin, id);
    return NextResponse.json({ ...result, items });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Extract failed' }, { status: 500 });
  }
}
