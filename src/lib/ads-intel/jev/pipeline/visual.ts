import crypto from 'node:crypto';
import { z } from 'zod';
import { db, must } from '../db';
import { env } from '../env';
import { chatJson, looseBool, looseNumber, looseString, looseStringArray, type ContentPart } from '../openrouter';
import { signedUrl } from '../storage';
import type { Product } from '../types';

/**
 * Scheda di caratteristiche visive: una DESCRIZIONE NEUTRA (niente giudizi) prodotta da un modello che vede
 * l'immagine. Jev non vede immagini: vota confrontando queste schede (immagine nuova vs vincenti vs perdenti).
 * Campi chiusi (enum) dove possibile: si confrontano meglio del testo libero.
 */
const Level = z.preprocess((v) => String(v ?? '').toLowerCase().trim(), z.enum(['none', 'low', 'medium', 'high']).catch('medium'));

export const VisualFeatures = z.object({
  format: z.preprocess((v) => String(v ?? '').toLowerCase().trim(), z.enum([
    'bold_text_graphic', 'fake_notification', 'fake_chat', 'fake_approval_or_certificate', 'official_notice_style',
    'social_post_screenshot', 'ugc_photo', 'lifestyle_photo', 'product_photo', 'meme', 'infographic', 'collage', 'other',
  ]).catch('other')),
  first_thing_seen: looseString,
  headline: z.object({
    text: looseString,
    height_share: looseNumber.catch(0),          // quota dell'altezza dell'immagine occupata dal titolo, 0..1
    contrast: Level,
    names_audience: looseBool.catch(false),
  }),
  audience_signals: looseStringArray,            // es. "word VETERANS in headline", "older man in cap"
  offer_statement: looseString,                  // cosa promette, in parole semplici
  cta: z.object({ present: looseBool.catch(false), text: looseString, looks_like_button: looseBool.catch(false) }),
  urgency_cues: looseStringArray,
  patriotic_elements: looseStringArray,          // bandiera, stelle, aquila, colori USA…
  authority_elements: looseStringArray,          // sigilli, badge, documenti, "notice", spunte di verifica…
  fake_ui_elements: looseStringArray,            // pulsanti finti, notifiche, chat, spunte…
  people: z.object({ present: looseBool.catch(false), description: looseString }),
  background: looseString,
  dominant_colors: looseStringArray,
  color_intensity: Level,
  text_amount: z.object({ blocks: looseNumber.catch(0), words: looseNumber.catch(0) }),
  clutter: Level,
  reads_as: z.preprocess((v) => String(v ?? '').toLowerCase().trim(), z.enum(['native_post', 'direct_response_ad', 'brand_ad', 'official_notice', 'stock_photo', 'other']).catch('other')),
});
export type VisualFeatures = z.infer<typeof VisualFeatures>;

const SYSTEM = 'You describe ad images for a structured database. Describe ONLY what is visible, precisely and neutrally. ' +
  'Do not judge quality or effectiveness. Estimate headline height_share as the fraction (0-1) of the image height taken by the main headline text. Answer with one JSON object in English.';

const SHAPE = 'Return JSON: format (bold_text_graphic | fake_notification | fake_chat | fake_approval_or_certificate | official_notice_style | social_post_screenshot | ugc_photo | lifestyle_photo | product_photo | meme | infographic | collage | other), ' +
  'first_thing_seen, headline{text, height_share (0-1), contrast (none|low|medium|high), names_audience (bool)}, audience_signals[], offer_statement, ' +
  'cta{present, text, looks_like_button}, urgency_cues[], patriotic_elements[], authority_elements[], fake_ui_elements[], people{present, description}, ' +
  'background, dominant_colors[], color_intensity (none|low|medium|high), text_amount{blocks, words}, clutter (none|low|medium|high), ' +
  'reads_as (native_post | direct_response_ad | brand_ad | official_notice | stock_photo | other).';

export async function describeVisual(imageUrl: string, projectId: string, audience?: string): Promise<VisualFeatures> {
  return chatJson({
    model: env.visionModel, purpose: 'visual:features', projectId, temperature: 0, maxTokens: 2500,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: `${audience ? `Target audience (only to decide names_audience): ${audience}\n` : ''}${SHAPE}` },
      ] as ContentPart[] },
    ],
  }, VisualFeatures);
}

/** Scheda di una creatività (immagine, primo elemento del carosello o fotogramma del video), calcolata una volta e salvata. */
export async function creativeFeatures(creativeId: string, projectId: string, audience?: string): Promise<VisualFeatures | null> {
  const c = must(await db().from('jev_creatives').select('id, media_type, media_paths, poster_path, visual_features').eq('id', creativeId).single()) as any;
  if (c.visual_features) return c.visual_features as VisualFeatures;
  const path = c.media_type === 'video' ? c.poster_path : c.media_paths?.[0];
  if (!path) return null;
  const f = await describeVisual(await signedUrl(path), projectId, audience).catch(() => null);
  if (f) await db().from('jev_creatives').update({ visual_features: f }).eq('id', creativeId);
  return f;
}

/** Versione compatta della scheda per lo state di Jev (senza campi vuoti). */
export function compactFeatures(f: VisualFeatures): Record<string, unknown> {
  const clean = (o: any): any => {
    if (Array.isArray(o)) return o.length ? o : undefined;
    if (o && typeof o === 'object') {
      const r = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clean(v)]).filter(([, v]) => v !== undefined && v !== ''));
      return Object.keys(r).length ? r : undefined;
    }
    return o;
  };
  return clean(f) ?? {};
}

/**
 * Scheda prodotto in inglese per Jev (lingua in cui è più accurato). Tradotta una volta e rigenerata
 * solo quando la scheda cambia (hash).
 */
const sheetCache = new Map<string, { sheet: string; audience: string }>();

export async function englishSheet(product: Product, sheet: string): Promise<{ sheet: string; audience: string }> {
  const source = JSON.stringify({ audience: product.avatar || product.benefit || '', sheet });
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
  const mem = sheetCache.get(`${product.id}:${hash}`);
  if (mem) return mem;
  const cached = (product as any).sheet_en as string | null;
  if (cached && (product as any).sheet_en_hash === hash) {
    try { const v = JSON.parse(cached); sheetCache.set(`${product.id}:${hash}`, v); return v; } catch { /* formato vecchio: si rigenera */ }
  }
  const r = await chatJson({
    model: env.writerModel, purpose: 'sheet:translate', projectId: product.project_id, temperature: 0, maxTokens: 5000,
    messages: [
      { role: 'system', content: 'Translate into plain English. Keep every fact, qualifier and limitation exactly; add nothing. Answer with one JSON object {audience, sheet}.' },
      { role: 'user', content: source },
    ],
  }, z.object({ audience: looseString, sheet: looseString }));
  await db().from('jev_products').update({ sheet_en: JSON.stringify(r), sheet_en_hash: hash }).eq('id', product.id);
  sheetCache.set(`${product.id}:${hash}`, r);
  return r;
}
