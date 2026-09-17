import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { canAccessProject } from '@/lib/auth/project-access';
import { lastImageGenError, openaiGenerateImageBytes, geminiImageKey, openaiImageKey } from '@/lib/openai-image';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 180;

const BUCKET = 'project-files';
const ANALYZE_PROMPT = `Analyze this advertisement still. Return ONLY JSON (no markdown) with:
{
  "layout": "short description of composition (split, overlay, UGC, before/after, product hero, etc.)",
  "productPlacement": "where the product sits and how large it is",
  "subjects": "people, setting, props",
  "colors": "palette and mood",
  "lighting": "lighting style",
  "texts": [{"role":"headline|sub|badge|cta|caption|legal","text":"..."}],
  "techniques": ["before/after","scarcity","authority", "..."],
  "notes": "anything else needed to rebuild the same structure"
}`;

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

async function analyzeLayout(imageUrl: string): Promise<string> {
  const geminiKey = geminiImageKey();
  if (geminiKey) {
    try {
      const img = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
      if (img.ok) {
        const buf = Buffer.from(await img.arrayBuffer());
        const mime = (img.headers.get('content-type') || 'image/jpeg').split(';')[0];
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { inline_data: { mime_type: mime, data: buf.toString('base64') } },
                  { text: ANALYZE_PROMPT },
                ],
              }],
              generationConfig: { temperature: 0.2 },
            }),
            signal: AbortSignal.timeout(60_000),
          },
        );
        if (res.ok) {
          const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const text = String(json.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
          if (text) return text;
        } else {
          console.warn('[ads/recreate] gemini vision', res.status, (await res.text()).slice(0, 240));
        }
      }
    } catch (e) {
      console.warn('[ads/recreate] gemini vision:', (e as Error).message);
    }
  }

  const key = openaiImageKey();
  if (!key) return '';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 900,
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: ANALYZE_PROMPT },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    console.warn('[ads/recreate] vision', res.status, (await res.text()).slice(0, 240));
    return '';
  }
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return String(json.choices?.[0]?.message?.content || '').trim();
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
  analysis: string;
  hasPackshot: boolean;
}): string {
  const name = opts.productName || 'our product';
  return [
    opts.hasPackshot
      ? 'The FIRST image is the winning ad LAYOUT to keep. The SECOND image is our exact packshot — the product in the new ad MUST be that packshot, not a made-up bottle.'
      : 'The attached image is the winning ad LAYOUT to keep.',
    `Recreate a BRAND NEW advertisement for ${name}.`,
    'Keep the same structure: same format, same number of panels, same product placement vs people, same information hierarchy, same lighting mood and color rhythm.',
    'Rewrite ALL on-image text (headlines, badges, captions, CTA, small print) so it sells OUR product. Do not copy competitor brand names, logos or medical claims.',
    opts.brief ? `Our product / project:\n${opts.brief}` : '',
    opts.analysis ? `Layout analysis of the original:\n${opts.analysis}` : '',
    'Photorealistic high-end commercial still, sharp typography, no watermarks.',
  ].filter(Boolean).join('\n\n');
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

    const ct = req.headers.get('content-type') || '';
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
      const body = await req.json().catch(() => ({}));
      projectId = String(body.projectId || '').trim();
      productId = String(body.productId || '').trim();
      productNameHint = String(body.productName || '').trim();
    }

    if (projectId) {
      const { allowed } = await canAccessProject(req, projectId);
      if (!allowed) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const sourceUrl = await signedUrl(source.file_path);
    if (!sourceUrl) {
      return NextResponse.json({ error: 'Could not sign the source ad image' }, { status: 500 });
    }

    let productName = productNameHint;
    let brief = '';
    let productImageUrl: string | null = null;

    if (projectId) {
      const ctx = await loadProjectCtx(projectId);
      productName = productName || ctx.name;
      brief = ctx.brief;
      productImageUrl = ctx.productImageUrl;
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
      productImageUrl = await signedUrl(key);
    }

    if (!productName && !productImageUrl && !brief) {
      return NextResponse.json(
        { error: 'Pick a project, a catalog product, or upload a product photo.' },
        { status: 400 },
      );
    }

    let analysis = '';
    try {
      analysis = await analyzeLayout(sourceUrl);
    } catch (e) {
      console.warn('[ads/recreate] analysis failed:', (e as Error).message);
    }

    const prompt = buildPrompt({
      productName: productName || 'our product',
      brief,
      analysis,
      hasPackshot: Boolean(productImageUrl),
    });

    const imageUrls = [sourceUrl, productImageUrl || ''].filter(Boolean);
    const made = await openaiGenerateImageBytes({
      prompt,
      imageUrls,
      size: 'auto',
      quality: 'medium',
      timeoutMs: 150_000,
    });
    if (!made) {
      return NextResponse.json(
        { error: lastImageGenError() || 'Image generation returned empty', analysis },
        { status: 502 },
      );
    }

    const ext = /webp/i.test(made.mime) ? 'webp' : /jpe?g/i.test(made.mime) ? 'jpg' : 'png';
    const outPath = `archive-ads/${userId}/recreate_${Date.now()}.${ext}`;
    const { error: saveErr } = await supabaseAdmin.storage.from(BUCKET).upload(outPath, made.buf, {
      contentType: made.mime,
      upsert: false,
    });
    if (saveErr) return NextResponse.json({ error: saveErr.message, analysis }, { status: 500 });

    const name = `${productName || 'Swipe'} — ${source.name}`.slice(0, 300);
    const row = {
      name,
      ad_type: source.ad_type,
      category: source.category,
      media_type: 'image',
      file_path: outPath,
      tags: analysis.slice(0, 4000),
      headline: productName || '',
      primary_text: brief.slice(0, 4000),
      owner_user_id: userId,
    };
    const { data: created, error: insErr } = await supabaseAdmin
      .from('archive_ads')
      .insert(row)
      .select()
      .single();
    if (insErr || !created) {
      return NextResponse.json({ error: insErr?.message || 'Saved file but could not register the ad', analysis }, { status: 500 });
    }

    return NextResponse.json({ ok: true, analysis, ad: created });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || 'Recreate failed' },
      { status: 500 },
    );
  }
}
