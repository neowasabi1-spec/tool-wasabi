import {
  applyPaintedMedia,
  applyPalette,
  collectRestyleSlots,
  fallbackPalette,
  injectRestyleMediaScript,
  type PaintedMedia,
} from '@/lib/restyle-slots';

type Gen = {
  status?: string;
  url?: string;
  error?: string;
  requestId?: string;
  statusUrl?: string;
  responseUrl?: string;
  modelKey?: string;
};

async function generateMedia(body: Record<string, unknown>): Promise<string> {
  const chain: Record<string, unknown>[] = [body];
  if (body.mode === 'text2image') {
    if (body.model !== 'flux-schnell') chain.push({ ...body, model: 'flux-schnell' });
    if (body.model !== 'nano-banana-2') chain.push({ ...body, model: 'nano-banana-2' });
  } else if (body.mode === 'image2image') {
    if (body.model !== 'nano-banana-2-edit') chain.push({ ...body, model: 'nano-banana-2-edit' });
    chain.push({
      mode: 'text2image',
      model: 'nano-banana-2',
      prompt: body.prompt,
      size: body.size,
    });
    chain.push({
      mode: 'text2image',
      model: 'flux-schnell',
      prompt: body.prompt,
      size: body.size,
    });
  }
  let last: Error | null = null;
  for (const attempt of chain) {
    try {
      return await generateMediaOnce(attempt);
    } catch (e) {
      last = e as Error;
    }
  }
  throw last || new Error('Generation failed');
}

async function generateMediaOnce(body: Record<string, unknown>): Promise<string> {
  const submit = await fetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = (await submit.json().catch(() => ({}))) as Gen;
  if (!submit.ok || data.status === 'error') {
    throw new Error(data.error || `generate HTTP ${submit.status}`);
  }
  const deadline = Date.now() + 4 * 60_000;
  while (data.status === 'pending' && data.requestId) {
    if (Date.now() > deadline) throw new Error('Generation timed out');
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'poll',
        requestId: data.requestId,
        statusUrl: data.statusUrl,
        responseUrl: data.responseUrl,
        modelKey: data.modelKey,
      }),
    });
    const next = (await poll.json().catch(() => ({}))) as Gen;
    if (next.status === 'error') throw new Error(next.error || 'poll failed');
    data = { ...data, ...next };
  }
  if (data.status !== 'completed' || !data.url) {
    throw new Error(data.error || 'No media URL');
  }
  return data.url;
}

export type VisualSlot = {
  id: number;
  src: string;
  kind: 'image' | 'gif' | 'video';
  role?: string;
  prompt: string;
  aspect: string;
  domTag?: 'img' | 'video';
  domIndex?: number;
};

const DEFAULT_ROLES = [
  'hero', 'product', 'lifestyle', 'lifestyle',
  'testimonial', 'ingredient', 'lifestyle', 'offer',
];

function defaultSlots(productName: string): VisualSlot[] {
  return DEFAULT_ROLES.map((role, i) => ({
    id: i,
    src: '',
    kind: 'image' as const,
    role,
    prompt: `Unique ${role} photograph for ${productName}. Premium commercial lighting. No competitor brands.`,
    aspect: role === 'hero' ? '16:9' : '4:3',
    domTag: 'img' as const,
    domIndex: i,
  }));
}

export async function runVisualRestyle(opts: {
  html: string;
  productName: string;
  brief?: string;
  research?: string;
  description?: string;
  projectId?: string;
  pageUrl?: string;
  onProgress?: (message: string, html?: string) => void;
}): Promise<{ html: string; replaced: number; total: number; failed: number; error?: string }> {
  const pageUrl = opts.pageUrl || '';
  const found = collectRestyleSlots(opts.html, 20, pageUrl);
  const slots = found.length ? found : [];
  const palette0 = fallbackPalette(opts.productName, `${opts.brief || ''} ${opts.description || ''}`);
  let html = applyPalette(opts.html, palette0);
  opts.onProgress?.(
    found.length
      ? `Palette applied — ${found.length} media to generate…`
      : 'Palette applied — no <img> found, generating a default photo pack…',
    html,
  );

  let workSlots: VisualSlot[] = [];
  let productUrl = '';
  let world = '';
  let avatar = '';

  if (slots.length) {
    opts.onProgress?.('Planning unique prompts for every photo/GIF/video…');
    const planRes = await fetch('/api/restyle-visual/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slots,
        productName: opts.productName,
        brief: opts.brief,
        research: opts.research,
        description: opts.description,
        projectId: opts.projectId,
      }),
    });
    const plan = (await planRes.json().catch(() => ({}))) as {
      error?: string;
      productImageUrl?: string | null;
      palette?: {
        primary: string; secondary: string; accent: string; background: string; ink: string;
        world?: string; avatar?: string;
      };
      slots?: VisualSlot[];
    };
    productUrl = plan.productImageUrl || '';
    world = plan.palette?.world || '';
    avatar = plan.palette?.avatar || '';
    workSlots = (plan.slots || []).map((s, i) => ({
      ...s,
      src: s.src || slots[i]?.src || '',
      domTag: s.domTag || slots[i]?.domTag,
      domIndex: s.domIndex ?? slots[i]?.domIndex,
    }));
    if (planRes.ok && plan.palette) {
      html = applyPalette(html, plan.palette);
    }
  }

  if (!workSlots.length) {
    workSlots = slots.length
      ? slots.map((s) => ({
          id: s.id,
          src: s.src,
          kind: s.kind,
          role: s.section,
          prompt: `Unique ${s.kind} for ${opts.productName}, ${s.section} section. ${s.alt || ''}`.trim(),
          aspect: s.kind === 'video' ? '16:9' : '4:3',
          domTag: s.domTag,
          domIndex: s.domIndex,
        }))
      : defaultSlots(opts.productName);
    opts.onProgress?.(`Generating ${workSlots.length} media…`, html);
  } else {
    opts.onProgress?.(`World ready — generating ${workSlots.length} unique media…`, html);
  }

  let replaced = 0;
  let failed = 0;
  let firstError = '';
  const paints: PaintedMedia[] = [];
  let nextImg = 0;
  let nextVideo = 0;

  for (let i = 0; i < workSlots.length; i++) {
    const slot = workSlots[i];
    const n = `${i + 1}/${workSlots.length}`;
    opts.onProgress?.(`${slot.kind} ${n} (${slot.role || slot.kind})…`, html);
    const unique = `${slot.prompt}\nUNIQUE FRAME ${slot.id + 1}: ${world} ${avatar}. Do not repeat any previous composition. Product: ${opts.productName}.`;
    try {
      const sourceUrl = /^https?:\/\//i.test(slot.src) ? slot.src : '';
      const isProduct = /product|pack|hero-product/i.test(slot.role || '');
      let still: string;
      if (isProduct && productUrl) {
        still = await generateMedia({
          mode: 'image2image',
          model: 'nano-banana-2-edit',
          prompt: unique.slice(0, 1800),
          imageUrl: productUrl,
          size: slot.aspect,
        });
      } else if (sourceUrl && slot.kind !== 'video') {
        still = await generateMedia({
          mode: 'image2image',
          model: 'nano-banana-2-edit',
          prompt: unique.slice(0, 1800),
          imageUrl: sourceUrl,
          size: slot.aspect,
        });
      } else {
        still = await generateMedia({
          mode: 'text2image',
          model: 'nano-banana-2',
          prompt: unique.slice(0, 1800),
          size: slot.aspect,
        });
      }
      let finalUrl = still;
      if (slot.kind === 'video') {
        opts.onProgress?.(`Video ${n} — animating the still…`, html);
        try {
          finalUrl = await generateMedia({
            mode: 'image2video',
            model: 'seedance-2',
            prompt: unique.slice(0, 800),
            imageUrl: still,
            duration: 5,
          });
        } catch {
          finalUrl = still;
        }
      }
      const tag: 'img' | 'video' = slot.kind === 'video' || slot.domTag === 'video' ? 'video' : 'img';
      const index = typeof slot.domIndex === 'number' ? slot.domIndex : (tag === 'video' ? nextVideo : nextImg);
      if (tag === 'video') nextVideo = Math.max(nextVideo, index + 1);
      else nextImg = Math.max(nextImg, index + 1);
      paints.push({
        tag,
        index,
        url: finalUrl,
        poster: slot.kind === 'video' ? still : undefined,
      });
      html = applyPaintedMedia(html, paints);
      replaced++;
      opts.onProgress?.(`${n} painted on ${tag}[${index}]`, html);
    } catch (e) {
      failed++;
      const msg = (e as Error).message || 'generate failed';
      if (!firstError) firstError = msg;
      opts.onProgress?.(`${n} failed: ${msg} — keeping original`, html);
    }
  }

  if (paints.length) {
    html = injectRestyleMediaScript(html, paints);
    opts.onProgress?.(`Media script on — ${paints.length} photos bound`, html);
  }

  return {
    html,
    replaced,
    total: workSlots.length,
    failed,
    error: replaced ? undefined : (firstError || 'No media replaced'),
  };
}
