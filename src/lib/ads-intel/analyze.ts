/**
 * Extract + light analyze for a competitor ad.
 * Local smoke works without OpenRouter (heuristic extraction from stored copy).
 * With OPENROUTER_API_KEY, enrich via vision/text chat.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUploadUrl } from '@/lib/projecthub-storage';
import { normalizeBrandRules, brandContext, brandRulesText } from './brain';
import {
  hasOpenRouter,
  openrouterChat,
  parseJsonLoose,
  visionModel,
  writerModel,
} from './openrouter';

export type AnalyzeTarget = {
  adSource: 'competitor' | 'own';
  adRefId: string;
};

function signedOrRaw(pathOrUrl: string): string {
  const p = (pathOrUrl || '').trim();
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  try {
    return getUploadUrl(p);
  } catch {
    return p;
  }
}

async function loadCompetitorAd(projectId: string, adId: string) {
  const { data, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', adId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`competitor_ad ${adId} not found`);
  return data as Record<string, unknown>;
}

async function loadBrand(projectId: string) {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('name, brand_rules')
    .eq('id', projectId)
    .single();
  if (error) throw new Error(error.message);
  return {
    name: String((data as { name?: string })?.name || 'Brand'),
    rules: normalizeBrandRules((data as { brand_rules?: unknown })?.brand_rules),
  };
}

function heuristicExtraction(ad: Record<string, unknown>) {
  return {
    media_type: String(ad.media_type || 'image'),
    headline: String(ad.headline || ''),
    hook: String(ad.hook || ''),
    body_text: String(ad.body_text || ''),
    landing_url: String(ad.landing_url || ''),
    mechanism_guess: [
      ad.hook && `Hook: ${ad.hook}`,
      ad.headline && `Headline: ${ad.headline}`,
      ad.body_text && `Body: ${String(ad.body_text).slice(0, 400)}`,
    ]
      .filter(Boolean)
      .join('\n') || '(no copy on file — upload/scrape media first)',
    source: 'heuristic',
  };
}

async function enrichWithLlm(
  projectName: string,
  rules: ReturnType<typeof normalizeBrandRules>,
  ad: Record<string, unknown>,
  base: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!hasOpenRouter()) return base;

  const mediaUrl = signedOrRaw(String(ad.file_path || ''));
  const system = [
    'You analyze Facebook/Meta ad creatives for persuasion mechanism.',
    'Return ONLY JSON with keys: mechanism, hook_type, offer_signals, visual_notes, risks.',
    'Do not rewrite the ad. Do not invent product facts.',
    brandContext(projectName, rules),
    brandRulesText(rules),
  ].join('\n\n');

  const userText = [
    `Headline: ${base.headline}`,
    `Hook: ${base.hook}`,
    `Body: ${base.body_text}`,
    `Landing: ${base.landing_url}`,
  ].join('\n');

  const messages =
    mediaUrl && String(ad.media_type || '').includes('image')
      ? [
          { role: 'system' as const, content: system },
          {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: userText },
              { type: 'image_url' as const, image_url: { url: mediaUrl } },
            ],
          },
        ]
      : [
          { role: 'system' as const, content: system },
          { role: 'user' as const, content: userText },
        ];

  const model = mediaUrl ? visionModel() : writerModel();
  const content = await openrouterChat({ model, messages, json: true, maxTokens: 2000 });
  const parsed = parseJsonLoose(content) as Record<string, unknown>;
  return {
    ...base,
    llm: parsed,
    source: 'openrouter',
  };
}

export async function analyzeCompetitorAd(
  projectId: string,
  adRefId: string,
  onProgress?: (msg: string) => Promise<void> | void,
): Promise<{ analysisId: number; extraction: Record<string, unknown> }> {
  await onProgress?.('Loading ad…');
  const ad = await loadCompetitorAd(projectId, adRefId);
  const brand = await loadBrand(projectId);

  await onProgress?.('Extracting…');
  let extraction = heuristicExtraction(ad);

  await supabaseAdmin.from('creative_analyses').upsert(
    {
      project_id: projectId,
      ad_source: 'competitor',
      ad_ref_id: String(adRefId),
      status: 'extracting',
      extraction,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id,ad_source,ad_ref_id' },
  );

  await onProgress?.('Analyzing…');
  try {
    extraction = (await enrichWithLlm(brand.name, brand.rules, ad, extraction)) as typeof extraction;
  } catch (e) {
    // Keep heuristic result; record warning in ranking
    const msg = e instanceof Error ? e.message : String(e);
    await onProgress?.(`LLM skipped: ${msg.slice(0, 120)}`);
  }

  const ranking = {
    has_copy: Boolean(extraction.headline || extraction.hook || extraction.body_text),
    has_llm: extraction.source === 'openrouter',
    analyzed_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('creative_analyses')
    .upsert(
      {
        project_id: projectId,
        ad_source: 'competitor',
        ad_ref_id: String(adRefId),
        status: 'ready',
        extraction,
        ranking,
        error: '',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,ad_source,ad_ref_id' },
    )
    .select('id')
    .single();

  if (error || !data) throw new Error(error?.message || 'Failed to save analysis');
  return { analysisId: Number(data.id), extraction };
}
