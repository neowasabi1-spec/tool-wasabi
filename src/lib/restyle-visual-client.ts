import { applyPalette, collectRestyleSlots, fallbackPalette, replaceMediaUrl } from '@/lib/restyle-slots';

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
  try {
    return await generateMediaOnce(body);
  } catch (first) {
    const mode = body.mode;
    if (mode === 'text2image' && body.model !== 'nano-banana-2') {
      return generateMediaOnce({ ...body, model: 'nano-banana-2' });
    }
    if (mode === 'image2image') {
      return generateMediaOnce({
        mode: 'text2image',
        model: 'nano-banana-2',
        prompt: body.prompt,
        size: body.size,
      });
    }
    throw first;
  }
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
};

export async function runVisualRestyle(opts: {
  html: string;
  productName: string;
  brief?: string;
  research?: string;
  description?: string;
  projectId?: string;
  onProgress?: (message: string, html?: string) => void;
}): Promise<{ html: string; replaced: number; total: number; failed: number }> {
  const slots = collectRestyleSlots(opts.html, 20);
  const palette0 = fallbackPalette(opts.productName, `${opts.brief || ''} ${opts.description || ''}`);
  let html = applyPalette(opts.html, palette0);
  opts.onProgress?.(`Palette applied — ${slots.length} media to generate…`, html);

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
  let workSlots: VisualSlot[] = plan.slots || [];
  if (!planRes.ok || !workSlots.length) {
    workSlots = slots.map((s) => ({
      id: s.id,
      src: s.src,
      kind: s.kind,
      role: s.section,
      prompt: `Unique ${s.kind} for ${opts.productName}, ${s.section} section. ${s.alt || ''}`.trim(),
      aspect: s.kind === 'video' ? '16:9' : '4:3',
    }));
    opts.onProgress?.(`Plan skipped — generating ${workSlots.length} media with fallback prompts…`, html);
  } else if (plan.palette) {
    html = applyPalette(html, plan.palette);
    opts.onProgress?.(`World ready — generating ${workSlots.length} unique media…`, html);
  }

  if (!workSlots.length) {
    return { html, replaced: 0, total: 0, failed: 0 };
  }

  let replaced = 0;
  let failed = 0;
  const productUrl = plan.productImageUrl || '';

  for (let i = 0; i < workSlots.length; i++) {
    const slot = workSlots[i];
    const n = `${i + 1}/${plan.slots.length}`;
    opts.onProgress?.(`${slot.kind} ${n} (${slot.role || slot.kind})…`, html);
    const unique = `${slot.prompt}\nUNIQUE FRAME ${slot.id + 1}: ${plan.palette?.world || ''} ${plan.palette?.avatar || ''}. Do not repeat any previous composition. Product: ${opts.productName}.`;
    try {
      const isProduct = /product|pack|hero-product/i.test(slot.role || '');
      let still: string;
      if (isProduct && productUrl) {
        still = await generateMedia({
          mode: 'image2image',
          model: 'gpt-image-2-edit',
          prompt: unique.slice(0, 1800),
          imageUrl: productUrl,
          size: slot.aspect,
        });
      } else {
        still = await generateMedia({
          mode: 'text2image',
          model: 'gpt-image-2',
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
      html = replaceMediaUrl(html, slot.src, finalUrl);
      if (slot.kind === 'video' && still) {
        html = html.replace(/<video\b[\s\S]*?<\/video>/gi, (block) => {
          if (!block.includes(finalUrl) && !block.includes(still)) return block;
          if (/\bposter\s*=/i.test(block)) {
            return block.replace(/(\bposter\s*=\s*["'])([^"']+)(["'])/i, `$1${still}$3`);
          }
          return block.replace(/<video\b/i, `<video poster="${still}"`);
        });
      }
      replaced++;
      opts.onProgress?.(`${n} replaced`, html);
    } catch (e) {
      failed++;
      opts.onProgress?.(`${n} failed: ${(e as Error).message} — keeping original`, html);
    }
  }

  return { html, replaced, total: plan.slots.length, failed };
}
