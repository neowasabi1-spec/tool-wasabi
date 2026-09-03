import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import {
  downloadedLandingMedia,
  extractLandingMediaForProject,
  extractLandingMediaFromHtml,
  ingestLandingMediaBytes,
  isLandingSection,
  listLandingMedia,
  type LandingMediaKind,
} from '@/lib/landing-media';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const items = downloadedLandingMedia(await listLandingMedia(supabaseAdmin, id));
  return NextResponse.json(items);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed, ctx } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const body = (await req.json().catch(() => ({}))) as { html?: string; pageUrl?: string };
    let result;
    if (typeof body.html === 'string' && body.html.length > 30) {
      result = await extractLandingMediaFromHtml(supabaseAdmin, {
        projectId: id,
        html: body.html,
        pageUrl: String(body.pageUrl || ''),
        ownerUserId: ctx.userId,
      });
    } else {
      result = await extractLandingMediaForProject(supabaseAdmin, id, ctx.userId);
    }
    const items = downloadedLandingMedia(await listLandingMedia(supabaseAdmin, id));
    return NextResponse.json({ ...result, items });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Extract failed' }, { status: 500 });
  }
}

/** Browser already has the file bytes (CORS-ok CDN). Store them as landing_media. */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed, ctx } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const fd = await req.formData();
    const file = fd.get('file');
    if (!(file instanceof File) || file.size < 80) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }
    const sourceUrl = String(fd.get('sourceUrl') || '');
    const kindRaw = String(fd.get('kind') || 'image');
    const kind: LandingMediaKind =
      kindRaw === 'gif' || kindRaw === 'video' ? kindRaw : 'image';
    const sectionRaw = String(fd.get('section') || 'other');
    const section = isLandingSection(sectionRaw) ? sectionRaw : 'other';
    const buf = Buffer.from(await file.arrayBuffer());
    const posRaw = Number(fd.get('position'));
    const item = await ingestLandingMediaBytes(supabaseAdmin, {
      projectId: id,
      buf,
      contentType: file.type || 'application/octet-stream',
      sourceUrl: sourceUrl || file.name,
      kind,
      section,
      position: Number.isFinite(posRaw) ? posRaw : undefined,
      ownerUserId: ctx.userId,
    });
    if (!item) return NextResponse.json({ error: 'Could not store file' }, { status: 500 });
    const items = downloadedLandingMedia(await listLandingMedia(supabaseAdmin, id));
    return NextResponse.json({ saved: 1, items, item });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Ingest failed' }, { status: 500 });
  }
}
