import { z } from 'zod';
import { loadProduct } from '../brain';
import { db } from '../db';
import { env } from '../env';
import { progress } from '../jobs';
import { chatJson } from '../openrouter';

const Sheet = z.object({
  description: z.string(),
  benefit: z.string(),
  mechanism: z.string(),
  features: z.string(),
  proof: z.string(),
  differentiators: z.string(),
  offer: z.string(),
  guarantee: z.string(),
  avatar: z.string(),
  product_sheet: z.string(),
});
const FIELDS = Object.keys(Sheet.shape) as (keyof z.infer<typeof Sheet>)[];

/** Testo leggibile di una pagina: niente script, stili e tag. */
export async function pageText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126 Safari/537.36', 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8' } });
  if (!res.ok) throw new Error(`Landing ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Compila la scheda prodotto da una landing o da un testo incollato.
 * Senza "sovrascrivi" riempie solo i campi vuoti. Non inventa: ciò che la fonte non dice resta vuoto.
 */
export async function fillProductSheet(productId: string, input: { url?: string; text?: string; overwrite?: boolean }, jobId?: string) {
  const { product, project } = await loadProduct(productId);
  let source = input.text?.trim() ?? '';
  if (!source && input.url) {
    await progress(jobId, `Lettura landing ${input.url}`);
    source = await pageText(input.url);
  }
  if (source.length < 200) throw new Error('Testo della landing troppo corto o vuoto (pagina renderizzata via JavaScript?). Incolla il testo a mano.');

  await progress(jobId, 'Estrazione della scheda prodotto');
  const sheet = await chatJson({
    model: env.writerModel, purpose: 'product_sheet', projectId: project.id, temperature: 0.1, maxTokens: 5000,
    messages: [
      {
        role: 'system',
        content: 'You extract a product fact sheet from a sales page, for a copywriting team. Use ONLY what the page states. ' +
          'If the page does not say something, leave that field as an empty string: never invent ingredients, numbers, studies or guarantees. ' +
          'Write each field in the language of the page. product_sheet is a detailed, structured explanation of the product (how it is used, what it contains, who it is for, objections answered on the page). Answer with one JSON object.',
      },
      {
        role: 'user',
        content: `Product name: ${product.name}\n\nPAGE TEXT\n${source.slice(0, 60000)}\n\nReturn JSON: description, benefit (the core result promised), mechanism (how it works), features (ingredients / components), proof (studies, reviews, numbers, certifications stated), differentiators (why it is different from alternatives), offer (price, bundles, discounts, shipping), guarantee, avatar (who it is for, their problems and objections), product_sheet.`,
      },
    ],
  }, Sheet);

  const patch: Record<string, string> = {};
  for (const f of FIELDS) {
    const current = String((product as Record<string, unknown>)[f] ?? '').trim();
    if (sheet[f].trim() && (input.overwrite || !current)) patch[f] = sheet[f].trim();
  }
  if (Object.keys(patch).length) await db().from('jev_products').update(patch).eq('id', productId);
  return { updated: Object.keys(patch) };
}
