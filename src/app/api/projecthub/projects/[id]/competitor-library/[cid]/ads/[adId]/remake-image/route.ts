import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const BUCKET = 'project-files';

/**
 * Prepare signed URLs + product context for remaking a competitor image,
 * or persist a finished fal.ai result onto the ad.
 *
 * POST { action: 'prepare' }
 * POST { action: 'save', url, prompt?, language?, mode? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; cid: string; adId: string } },
) {
  const { id, cid, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const adIdNum = Number(adId);
  const brandIdNum = Number(cid);
  if (!Number.isFinite(adIdNum) || !Number.isFinite(brandIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = String(body.action || 'prepare');

  if (action === 'save') return saveResult(id, brandIdNum, adIdNum, body);

  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, file_path, media_type, name, headline, hook, body_text')
    .eq('id', adIdNum)
    .eq('brand_id', brandIdNum)
    .eq('project_id', id)
    .maybeSingle();
  if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });
  const a = ad as {
    file_path?: string; media_type?: string; name?: string;
    headline?: string; hook?: string; body_text?: string;
  };
  if (a.media_type === 'video' || !a.file_path) {
    return NextResponse.json({ error: 'This action is for still images' }, { status: 400 });
  }

  const imageUrl = await signedUrl(a.file_path);
  if (!imageUrl) {
    return NextResponse.json({ error: 'Could not sign the source image' }, { status: 500 });
  }

  const [productImageUrl, project] = await Promise.all([
    loadProductImage(id),
    loadProjectCtx(id),
  ]);
  const p = project;

  return NextResponse.json({
    imageUrl,
    productImageUrl,
    productName: String(p.name || '').trim(),
    brief: String(p.brief || p.description || '').slice(0, 4000),
    headline: a.headline || '',
    hook: a.hook || '',
    bodyText: a.body_text || '',
    name: a.name || '',
  });
}

async function saveResult(
  projectId: string,
  brandId: number,
  adId: number,
  body: Record<string, unknown>,
) {
  const url = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'Missing result URL' }, { status: 400 });
  }
  const dl = await fetch(url);
  if (!dl.ok) {
    return NextResponse.json({ error: `Could not download the result (${dl.status})` }, { status: 502 });
  }
  const buf = Buffer.from(await dl.arrayBuffer());
  const mime = (dl.headers.get('content-type') || 'image/png').split(';')[0].trim();
  const ext = /webp/i.test(mime) ? 'webp' : /jpe?g/i.test(mime) ? 'jpg' : 'png';
  const key = `${projectId}/generated/${adId}_img_${Date.now()}.${ext}`;
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(key, buf, {
    contentType: mime || 'image/png',
    upsert: true,
  });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const language = String(body.language || '').trim().slice(0, 40) || null;
  const prompt = String(body.prompt || body.mode || '').trim().slice(0, 2000);
  const row: Record<string, unknown> = {
    project_id: projectId,
    brand_id: brandId,
    ad_id: adId,
    file_path: key,
    thumb_path: key,
    duration_sec: 0,
    script: prompt || null,
    language,
  };
  let res = await supabaseAdmin.from('generated_videos').insert(row).select('*').maybeSingle();
  if (res.error && /language/i.test(res.error.message)) {
    delete row.language;
    res = await supabaseAdmin.from('generated_videos').insert(row).select('*').maybeSingle();
  }
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, video: res.data });
}

async function loadProjectCtx(projectId: string): Promise<{ name?: string; brief?: string; description?: string }> {
  const full = await supabaseAdmin
    .from('projects')
    .select('name, brief, description')
    .eq('id', projectId)
    .maybeSingle();
  if (!full.error) return (full.data || {}) as { name?: string; brief?: string; description?: string };
  const slim = await supabaseAdmin
    .from('projects')
    .select('name, description')
    .eq('id', projectId)
    .maybeSingle();
  return (slim.data || {}) as { name?: string; description?: string };
}

async function signedUrl(path: string): Promise<string | null> {
  if (/^https?:\/\//i.test(path)) return path;
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

async function loadProductImage(projectId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from('project_files')
      .select('file_path, original_name, created_at')
      .eq('project_id', projectId)
      .eq('file_type', 'product_image')
      .order('created_at', { ascending: false })
      .limit(20);
    const rows = (data || []) as Array<{ file_path: string; original_name?: string | null }>;
    if (!rows.length) return null;
    const main = rows.find((r) => !/upsell/i.test(r.original_name || '')) || rows[0];
    return signedUrl(main.file_path);
  } catch {
    return null;
  }
}
