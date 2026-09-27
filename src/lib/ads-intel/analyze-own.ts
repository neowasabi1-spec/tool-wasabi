import { supabaseAdmin } from '@/lib/supabase-admin';
import { normalizeBrandRules, brandContext, brandRulesText } from './brain';
import { hasOpenRouter, openrouterChat, parseJsonLoose, writerModel } from './openrouter';

export async function analyzeOwnAd(
  projectId: string,
  adRefId: string,
  onProgress?: (msg: string) => Promise<void> | void,
) {
  await onProgress?.('Loading own ad…');
  const { data: ad, error } = await supabaseAdmin
    .from('own_ads')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', adRefId)
    .maybeSingle();
  if (error || !ad) throw new Error(error?.message || `own_ad ${adRefId} not found`);

  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('name, brand_rules')
    .eq('id', projectId)
    .single();
  const rules = normalizeBrandRules(project?.brand_rules);
  const name = String(project?.name || 'Brand');

  let extraction: Record<string, unknown> = {
    media_type: ad.media_type,
    headline: ad.headline,
    hook: '',
    body_text: ad.body_text,
    ad_name: ad.ad_name,
    mechanism_guess: [ad.ad_name, ad.headline, ad.body_text].filter(Boolean).join('\n'),
    source: 'own_heuristic',
  };

  if (hasOpenRouter()) {
    await onProgress?.('Analyzing with LLM…');
    try {
      const content = await openrouterChat({
        model: writerModel(),
        messages: [
          {
            role: 'system',
            content: [
              'Analyze our own Meta ad for persuasion mechanism. JSON keys: mechanism, hook_type, offer_signals, risks.',
              brandContext(name, rules),
              brandRulesText(rules),
            ].join('\n\n'),
          },
          {
            role: 'user',
            content: `Ad name: ${ad.ad_name}\nHeadline: ${ad.headline}\nBody: ${ad.body_text}`,
          },
        ],
        json: true,
      });
      extraction = { ...extraction, llm: parseJsonLoose(content), source: 'openrouter' };
    } catch (e) {
      await onProgress?.(e instanceof Error ? e.message : String(e));
    }
  }

  const { data, error: upErr } = await supabaseAdmin
    .from('creative_analyses')
    .upsert(
      {
        project_id: projectId,
        ad_source: 'own',
        ad_ref_id: String(adRefId),
        status: 'ready',
        extraction,
        ranking: { analyzed_at: new Date().toISOString() },
        error: '',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,ad_source,ad_ref_id' },
    )
    .select('id')
    .single();
  if (upErr) throw new Error(upErr.message);
  return { analysisId: Number(data.id), extraction };
}
