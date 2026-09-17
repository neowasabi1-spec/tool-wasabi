import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const BUCKET = 'project-files';

type SourceAd = {
  id: string;
  name: string;
  ad_type: string;
  category: string;
  media_type: string;
  file_path: string;
};

async function signedUrl(path: string): Promise<string | null> {
  if (/^https?:\/\//i.test(path)) return path;
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

async function loadProjectCtx(projectId: string) {
  let name = '';
  let brief = '';
  const full = await supabaseAdmin
    .from('projects')
    .select('name, brief, description')
    .eq('id', projectId)
    .maybeSingle();
  if (!full.error) {
    const p = (full.data || {}) as { name?: string; brief?: string; description?: string };
    name = String(p.name || '').trim();
    brief = String(p.brief || p.description || '').trim();
  } else {
    const slim = await supabaseAdmin
      .from('projects')
      .select('name, description')
      .eq('id', projectId)
      .maybeSingle();
    const p = (slim.data || {}) as { name?: string; description?: string };
    name = String(p.name || '').trim();
    brief = String(p.description || '').trim();
  }

  const { data: files } = await supabaseAdmin
    .from('project_files')
    .select('file_path, original_name, created_at')
    .eq('project_id', projectId)
    .eq('file_type', 'product_image')
    .order('created_at', { ascending: false })
    .limit(20);
  const rows = (files || []) as Array<{ file_path: string; original_name?: string | null }>;
  const main = rows.find((r) => !/upsell/i.test(r.original_name || '')) || rows[0];
  const productImageUrl = main?.file_path ? await signedUrl(main.file_path) : null;
  return {
    name,
    brief: brief.slice(0, 3500),
    productImageUrl,
    productPath: main?.file_path || null,
  };
}

async function loadCatalogProduct(productId: string) {
  const { data } = await supabaseAdmin
    .from('products')
    .select('id, name, description, brand_name, benefits, image_url, cta_text')
    .eq('id', productId)
    .maybeSingle();
  if (!data) return null;
  const p = data as {
    name?: string; description?: string; brand_name?: string;
    benefits?: string[]; image_url?: string | null; cta_text?: string;
  };
  const benefits = Array.isArray(p.benefits) ? p.benefits.filter(Boolean).slice(0, 8).join('; ') : '';
  return {
    name: String(p.name || '').trim(),
    brief: [p.brand_name, p.description, benefits, p.cta_text].filter(Boolean).join('\n').slice(0, 3500),
    productImageUrl: p.image_url && /^https?:\/\//i.test(p.image_url) ? p.image_url : null,
  };
}

function buildPrompt(opts: {
  productName: string;
  brief: string;
  hasPackshot: boolean;
}): string {
  const name = opts.productName || 'our product';
  const facts = opts.brief.replace(/\s+/g, ' ').trim().slice(0, 1400);
  const parts = [
    `Recreate this competitor ad as a finished ad for ${name}.`,
    opts.hasPackshot
      ? `The FIRST image is the layout to copy. The SECOND image is our exact packshot — replace every competitor product with that packshot, matching its real shape, label and colors.`
      : `Keep the same layout, people and composition, but the ad must clearly be for ${name}.`,
    'Keep the same format: grid, framing, people poses, icon/badge positions, and overall composition.',
    `Rewrite EVERY visible text (headlines, subheads, bullets, badges, captions, CTAs, small print) so it sells ${name}.`,
    `Do not keep the original product name, category, medical claims, or before/after if they do not match ${name}.`,
    'Change the color palette, backgrounds, graphic accents and packaging colors to match our product branding from the packshot / product facts.',
    'Replace original insets, before/after, or category-specific graphics with visuals that make sense for our product.',
    'Remove competitor logos, competitor brand names, and leftover original claims.',
  ];
  if (facts) {
    parts.push(`Use these product facts in the copy (do not invent extra medical claims): ${facts}`);
  } else {
    parts.push(`If the packshot has a brand, product name, or category on the label, use those in the copy together with the name ${name}.`);
  }
  return parts.join(' ');
}

async function saveToProjectCreatives(
  req: NextRequest,
  userId: string,
  body: Record<string, unknown>,
) {
  const projectId = String(body.projectId || '').trim();
  const filePath = String(body.filePath || '').trim();
  const name = String(body.name || 'Recreated ad').trim().slice(0, 300) || 'Recreated ad';
  if (!projectId) {
    return NextResponse.json({ error: 'Pick a project to save into Creative' }, { status: 400 });
  }
  if (!filePath) {
    return NextResponse.json({ error: 'Missing generated image' }, { status: 400 });
  }
  const allowedPrefix = `archive-ads/${userId}/`;
  if (!filePath.startsWith(allowedPrefix)) {
    return NextResponse.json({ error: 'Invalid file' }, { status: 400 });
  }
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(BUCKET).download(filePath);
  if (dlErr || !blob) {
    return NextResponse.json({ error: dlErr?.message || 'Could not read generated image' }, { status: 500 });
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  const ext = (filePath.split('.').pop() || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const dest = `${projectId}/creatives/recreate_${Date.now()}.${ext}`;
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(dest, buf, {
    contentType: mime,
    upsert: false,
  });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const { data: created, error: insErr } = await supabaseAdmin
    .from('creative_templates')
    .insert({
      project_id: projectId,
      name,
      source_brand: '',
      category: 'Recreated ads',
      file_path: dest,
      media_type: 'image',
      tags: '',
    })
    .select()
    .single();
  if (insErr || !created) {
    return NextResponse.json(
      { error: insErr?.message || 'Copied file but could not add it to Creative' },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, creative: created, filePath: dest });
}

async function persistGenerated(
  userId: string,
  name: string,
  buf: Buffer,
  mime: string,
) {
  const ext = /webp/i.test(mime) ? 'webp' : /jpe?g/i.test(mime) ? 'jpg' : 'png';
  const outPath = `archive-ads/${userId}/drafts/recreate_${Date.now()}.${ext}`;
  const { error: saveErr } = await supabaseAdmin.storage.from(BUCKET).upload(outPath, buf, {
    contentType: mime,
    upsert: false,
  });
  if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 500 });
  const previewUrl = `/api/projecthub/file-proxy?path=${encodeURIComponent(outPath)}`;
  return NextResponse.json({
    ok: true,
    status: 'completed',
    filePath: outPath,
    name,
    previewUrl,
  });
}

async function ingestGenerated(userId: string, body: Record<string, unknown>) {
  const url = String(body.url || '').trim();
  const name = String(body.name || 'Recreated ad').trim().slice(0, 300) || 'Recreated ad';
  if (!url) return NextResponse.json({ error: 'Missing generated image' }, { status: 400 });
  try {
    let buf: Buffer;
    let mime = 'image/png';
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return NextResponse.json({ error: 'Invalid image data' }, { status: 400 });
      mime = m[1] || 'image/png';
      buf = Buffer.from(m[2], 'base64');
    } else {
      if (!/^https?:\/\//i.test(url)) {
        return NextResponse.json({ error: 'Invalid image URL' }, { status: 400 });
      }
      const dl = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!dl.ok) return NextResponse.json({ error: 'Could not download the generated image' }, { status: 502 });
      buf = Buffer.from(await dl.arrayBuffer());
      mime = (dl.headers.get('content-type') || 'image/png').split(';')[0].trim();
    }
    if (buf.length < 80) return NextResponse.json({ error: 'Generated image was empty' }, { status: 502 });
    return persistGenerated(userId, name, buf, mime);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Could not save preview' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data, error } = await supabaseAdmin
    .from('products')
    .select('id, name, brand_name, image_url')
    .order('name', { ascending: true })
    .limit(200);
  if (error) return NextResponse.json({ products: [] });
  return NextResponse.json({ products: data || [] });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const ct = req.headers.get('content-type') || '';
    let jsonBody: Record<string, unknown> | null = null;
    if (!ct.includes('multipart/form-data')) {
      jsonBody = await req.json().catch(() => ({} as Record<string, unknown>));
      if (String(jsonBody.action || '') === 'save') {
        return saveToProjectCreatives(req, userId, jsonBody);
      }
      if (String(jsonBody.action || '') === 'ingest') {
        return ingestGenerated(userId, jsonBody);
      }
    }

    const { data: ad } = await supabaseAdmin
      .from('archive_ads')
      .select('id, name, ad_type, category, media_type, file_path')
      .eq('id', params.id)
      .maybeSingle();
    if (!ad) return NextResponse.json({ error: 'Ad not found' }, { status: 404 });
    const source = ad as SourceAd;
    if (source.media_type === 'video' || source.media_type === 'folder' || !source.file_path) {
      return NextResponse.json({ error: 'Recreate is available for still images only' }, { status: 400 });
    }

    let projectId = '';
    let productId = '';
    let productNameHint = '';
    let uploadedProduct: { buf: Buffer; mime: string } | null = null;

    if (ct.includes('multipart/form-data')) {
      const fd = await req.formData().catch(() => null);
      if (!fd) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 });
      projectId = String(fd.get('projectId') || '').trim();
      productId = String(fd.get('productId') || '').trim();
      productNameHint = String(fd.get('productName') || '').trim();
      const file = fd.get('file');
      if (file instanceof File && file.size > 0) {
        if (file.size > 8 * 1024 * 1024) {
          return NextResponse.json({ error: 'Product photo must be 8 MB or smaller' }, { status: 400 });
        }
        const mime = (file.type || 'image/jpeg').split(';')[0].toLowerCase();
        if (mime && !/^image\/(jpeg|jpg|png|webp)$/.test(mime)) {
          return NextResponse.json({ error: 'Use a JPG, PNG or WebP product photo' }, { status: 400 });
        }
        uploadedProduct = {
          buf: Buffer.from(await file.arrayBuffer()),
          mime: mime || 'image/jpeg',
        };
      }
    } else {
      projectId = String(jsonBody?.projectId || '').trim();
      productId = String(jsonBody?.productId || '').trim();
      productNameHint = String(jsonBody?.productName || '').trim();
    }

    if (projectId) {
      const { allowed } = await canAccessProject(req, projectId);
      if (!allowed) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    let productName = productNameHint;
    let brief = '';
    let productImageUrl: string | null = null;
    let productPath: string | null = null;

    if (projectId) {
      const ctx = await loadProjectCtx(projectId);
      productName = productName || ctx.name;
      brief = ctx.brief;
      productImageUrl = ctx.productImageUrl;
      productPath = ctx.productPath;
    }
    if (productId) {
      const cat = await loadCatalogProduct(productId);
      if (cat) {
        productName = productName || cat.name;
        brief = [brief, cat.brief].filter(Boolean).join('\n');
        productImageUrl = productImageUrl || cat.productImageUrl;
      }
    }

    if (uploadedProduct) {
      const ext = /png/i.test(uploadedProduct.mime) ? 'png' : /webp/i.test(uploadedProduct.mime) ? 'webp' : 'jpg';
      const key = `archive-ads/${userId}/product_${Date.now()}.${ext}`;
      const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(key, uploadedProduct.buf, {
        contentType: uploadedProduct.mime,
        upsert: false,
      });
      if (upErr) return NextResponse.json({ error: `Product photo upload failed: ${upErr.message}` }, { status: 500 });
      productPath = key;
      productImageUrl = await signedUrl(key);
    }

    if (!productName && !productImageUrl && !brief) {
      return NextResponse.json(
        { error: 'Pick a project, a catalog product, or upload a product photo.' },
        { status: 400 },
      );
    }

    const hasPackshot = Boolean(productPath || productImageUrl);
    const prompt = buildPrompt({
      productName: productName || 'our product',
      brief,
      hasPackshot,
    });

    const name = `${productName || 'Swipe'} — ${source.name}`.slice(0, 300);
    const publicProductUrl =
      productImageUrl && /^https?:\/\//i.test(productImageUrl) && !/supabase\.co\/storage/i.test(productImageUrl)
        ? productImageUrl
        : '';
    return NextResponse.json({
      ok: true,
      status: 'ready',
      name,
      prompt,
      imagePath: source.file_path,
      productPath: productPath || '',
      productImageUrl: publicProductUrl,
    });
  } catch (e) {
    const msg = (e as Error).message || 'Recreate failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
