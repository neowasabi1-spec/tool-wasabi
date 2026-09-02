import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { extForContentType, mediaTypeForContentType } from '@/lib/competitor-ads';
import {
  encodeCreativeCopy,
  ensureCreativeFolder,
  parseCreativeCopy,
  resolveFolder,
  type FolderRef,
} from '@/lib/creative-library';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Creative → Creatives library (NOT the Competitor Library).
 *
 *   GET  ?projectId=[&folderId=][&foldersOnly=1]
 *   POST { kind:'folder', projectId, name }
 *   POST { kind:'file', projectId, folderId|folderName, mediaUrl|filePath, … }
 */

type Row = {
  id: number;
  name: string;
  category: string;
  file_path: string;
  media_type: string;
  tags: string;
  created_at: string;
};

async function fetchMedia(url: string, referer: string, timeoutMs = 45000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: referer || url,
        Accept: '*/*',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    return buffer.length > 0 ? { buffer, contentType } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function shapeCreative(r: Row, folder: FolderRef | null) {
  const copy = parseCreativeCopy(r.tags);
  return {
    id: r.id,
    name: r.name,
    folderId: folder?.folderId ?? null,
    folderName: folder?.name || r.category || '',
    filePath: r.file_path,
    mediaType: r.media_type,
    headline: copy.headline,
    hook: copy.hook,
    bodyText: copy.bodyText,
    created_at: r.created_at,
  };
}

async function loadRows(projectId: string): Promise<Row[]> {
  const { data, error } = await supabaseAdmin
    .from('creative_templates')
    .select('id, name, category, file_path, media_type, tags, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as Row[];
}

async function folderMap(projectId: string, rows: Row[]): Promise<Map<string, FolderRef>> {
  const map = new Map<string, FolderRef>();
  for (const r of rows.filter((x) => x.media_type === 'folder')) {
    map.set(r.name.toLowerCase(), { folderId: r.id, name: r.name });
  }
  // Implicit folders (items with a category but no folder row) — materialize
  // so MCP always gets a folderId.
  const implicit = [...new Set(
    rows.filter((r) => r.media_type !== 'folder' && r.category).map((r) => r.category),
  )];
  for (const name of implicit) {
    if (map.has(name.toLowerCase())) continue;
    const created = await ensureCreativeFolder(projectId, name);
    map.set(created.name.toLowerCase(), created);
  }
  return map;
}

export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req, 'read_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const projectId = req.nextUrl.searchParams.get('projectId')?.trim() || '';
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  const folderIdParam = Number(req.nextUrl.searchParams.get('folderId'));
  const foldersOnly = req.nextUrl.searchParams.get('foldersOnly') === '1';

  let rows: Row[];
  try {
    rows = await loadRows(projectId);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'load failed' }, { status: 500 });
  }

  const fmap = await folderMap(projectId, rows);
  const items = rows.filter((r) => r.media_type !== 'folder');
  const folders = [...fmap.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => ({
      folderId: f.folderId,
      name: f.name,
      count: items.filter((i) => i.category.toLowerCase() === f.name.toLowerCase()).length,
    }));

  if (foldersOnly) {
    return NextResponse.json({ projectId, folders, count: folders.length });
  }

  let filtered = items;
  if (Number.isFinite(folderIdParam) && folderIdParam > 0) {
    const target = [...fmap.values()].find((f) => f.folderId === folderIdParam);
    if (!target) return NextResponse.json({ error: 'folderId not found' }, { status: 404 });
    filtered = items.filter((i) => i.category.toLowerCase() === target.name.toLowerCase());
  }

  const creatives = filtered.map((r) =>
    shapeCreative(r, r.category ? fmap.get(r.category.toLowerCase()) || null : null),
  );

  return NextResponse.json({
    projectId,
    folders,
    creatives,
    count: creatives.length,
  });
}

export async function POST(req: NextRequest) {
  const auth = await validateApiKey(req, 'write_products');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const projectId = String(body.projectId || body.project_id || '').trim();
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  const kind = String(body.kind || (body.mediaUrl || body.filePath ? 'file' : 'folder')).trim();

  if (kind === 'folder') {
    const name = String(body.name || '').trim();
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    try {
      const folder = await ensureCreativeFolder(projectId, name);
      return NextResponse.json({ folderId: folder.folderId, name: folder.name });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
    }
  }

  if (kind !== 'file') {
    return NextResponse.json({ error: "kind must be 'folder' or 'file'" }, { status: 400 });
  }

  let folder: FolderRef | null = null;
  try {
    folder = await resolveFolder(
      projectId,
      Number(body.folderId) || null,
      String(body.folderName || body.folder || ''),
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'folder error' }, { status: 400 });
  }

  const mediaUrl = String(body.mediaUrl || body.media_url || '').trim();
  const givenPath = String(body.filePath || body.file_path || '').trim();
  if (!mediaUrl && !givenPath) {
    return NextResponse.json({ error: 'mediaUrl or filePath is required' }, { status: 400 });
  }

  const mediaHint = body.mediaType === 'video' ? 'video' : body.mediaType === 'image' ? 'image' : undefined;
  let filePath = givenPath;
  let mediaType: 'image' | 'video' = mediaHint || 'image';

  if (!filePath && /^https?:\/\//i.test(mediaUrl)) {
    const fetched = await fetchMedia(mediaUrl, String(body.pageUrl || mediaUrl), mediaHint === 'video' ? 45000 : 15000);
    if (!fetched) {
      return NextResponse.json({ error: 'Could not download the file from mediaUrl' }, { status: 422 });
    }
    let contentType = fetched.contentType;
    if (mediaHint === 'video' && !/^video\//i.test(contentType)) contentType = 'video/mp4';
    if (mediaHint === 'image' && !/^image\//i.test(contentType)) contentType = 'image/jpeg';
    mediaType = mediaTypeForContentType(contentType);
    const ext = extForContentType(contentType, mediaType === 'video' ? 'mp4' : 'jpg');
    const rand = Math.random().toString(36).slice(2, 8);
    filePath = `${projectId}/creatives/${Date.now()}_${rand}.${ext}`;
    const { error: upErr } = await supabaseAdmin.storage.from('project-files').upload(filePath, fetched.buffer, {
      contentType,
      upsert: false,
    });
    if (upErr) return NextResponse.json({ error: `Upload failed: ${upErr.message}` }, { status: 500 });
  } else if (filePath && mediaHint) {
    mediaType = mediaHint;
  } else if (filePath) {
    mediaType = /\.(mp4|webm|mov|ogv)(\?|$)/i.test(filePath) ? 'video' : 'image';
  }

  const copy = {
    headline: String(body.headline || ''),
    hook: String(body.hook || ''),
    bodyText: String(body.bodyText || body.body_text || body.text || ''),
  };

  const { data, error } = await supabaseAdmin
    .from('creative_templates')
    .insert({
      project_id: projectId,
      name: String(body.name || copy.headline || 'Creative').trim().slice(0, 300),
      media_type: mediaType,
      file_path: filePath,
      category: folder?.name || '',
      source_brand: '',
      tags: encodeCreativeCopy(copy),
    })
    .select('id, name, category, file_path, media_type, tags, created_at')
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message || 'Insert failed' }, { status: 500 });

  return NextResponse.json(shapeCreative(data as Row, folder));
}
