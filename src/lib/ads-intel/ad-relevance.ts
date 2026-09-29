/**
 * Jev (or Claude fallback) scores scraped ads against OUR product.
 * Used for vertical peers and competitor spy: is this ad usable inspiration?
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadDiscoveryLexicon } from '@/lib/discovery-lexicon';
import { buildState, engine, norm } from '@/lib/ads-intel/jev/judge';
import type { QuestionSet } from '@/lib/ads-intel/jev/judge/types';
import { env } from '@/lib/ads-intel/jev/env';

export type RelevanceLabel = 'strong' | 'adjacent' | 'off_target';

export type AdRelevance = {
  score: number; // 0..100
  label: RelevanceLabel;
  why: string;
  comparable: boolean;
  engine: string;
};

const QUESTIONS: QuestionSet = {
  same_buyer_intent: {
    type: 'noul',
    instructions: {
      question: 'Would someone evaluating `our_product` also reasonably consider the offer advertised in `ad`?',
      focus: 'Same buyer problem and offer type (e.g. phone/WiFi income info product vs Social Profits Machine). Not the identical brand — a peer in the same vertical.',
    },
    criteria: {
      true: {
        what: 'Same vertical / buyer intent (comparable info product, system, or SKU a media buyer would spy for creative parallels).',
        not_for: 'Hardware, ISPs, SaaS tools, shops, unrelated categories that only share a keyword.',
        examples: ['Wifi Profits when we sell Social Profits Machine', 'another slim-coffee brand when we sell a slim coffee'],
      },
      false: {
        what: 'Different product category or not an offer a buyer of ours would compare.',
        examples: ['WiFi router ads', 'hotel booking', 'generic CapCut tutorial', 'marketplace'],
      },
    },
  },
  inspiration_value: {
    type: 'score',
    instructions: {
      question: 'How useful is `ad` as creative inspiration for ads promoting `our_product`?',
      focus: 'Hook, angle, format, and promise transferability — not whether it is the same SKU.',
    },
    criteria: [
      { what: 'Off-target or useless for our creatives', examples: ['wrong category', 'no readable offer'] },
      { what: 'Loosely related — same niche vibe but weak transfer', examples: ['generic make-money fluff'] },
      { what: 'Strong peer — angles/hooks/formats we could adapt', examples: ['Wifi Profits phone-income VSL angles for Social Profits Machine'] },
    ],
  },
};

function labelFrom(score: number, comparable: boolean): RelevanceLabel {
  if (!comparable || score < 40) return 'off_target';
  if (score >= 70) return 'strong';
  return 'adjacent';
}

function whyFrom(comparable: boolean, pTrue: number, insp: number): string {
  if (!comparable) return `Different buyer intent (p=${pTrue.toFixed(2)})`;
  if (insp >= 1.5) return 'Strong creative peer';
  if (insp >= 0.75) return 'Same vertical, moderate transfer';
  return 'Weak inspiration match';
}

export async function scoreAdRelevance(opts: {
  projectId: string;
  ourProduct: string;
  ourDescription?: string;
  adText: string;
  pageName?: string;
}): Promise<AdRelevance> {
  const eng = engine();
  const state = buildState({
    our_product: [
      opts.ourProduct,
      opts.ourDescription ? `What it is: ${opts.ourDescription.slice(0, 1200)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    ad: [
      opts.pageName ? `Page: ${opts.pageName}` : '',
      opts.adText.slice(0, 2500),
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const answers = await eng.ask(state, QUESTIONS, {
    purpose: 'ad_relevance',
    projectId: opts.projectId,
  });

  const same = answers.same_buyer_intent;
  const insp = answers.inspiration_value;
  const pTrue = same?.type === 'noul' ? Number(same.pTrue ?? (same.value ? same.p : 1 - same.p)) : 0;
  const comparable = pTrue >= 0.45;
  const inspNorm = norm(insp); // 0..1 from score 0..2
  const score = Math.round(
    100 * Math.max(0, Math.min(1, 0.45 * pTrue + 0.55 * (comparable ? inspNorm : inspNorm * 0.35))),
  );
  const label = labelFrom(score, comparable);
  return {
    score,
    label,
    why: whyFrom(comparable, pTrue, Number(insp?.value ?? 0)),
    comparable,
    engine: eng.name,
  };
}

type AdRow = {
  id: number;
  brand_id: number;
  name?: string | null;
  headline?: string | null;
  hook?: string | null;
  body_text?: string | null;
  transcript?: string | null;
};

async function loadOurProduct(projectId: string): Promise<{ name: string; description: string }> {
  const [{ data: project }, lexicon] = await Promise.all([
    supabaseAdmin.from('projects').select('name, description').eq('id', projectId).maybeSingle(),
    loadDiscoveryLexicon(supabaseAdmin, projectId),
  ]);
  const name = (lexicon.product?.name || project?.name || '').trim() || 'Our product';
  const description = [
    lexicon.product?.description,
    typeof project?.description === 'string' ? project.description : '',
    lexicon.product?.offerUrl ? `Offer: ${lexicon.product.offerUrl}` : '',
    (lexicon.product?.names || []).length ? `Also known as: ${lexicon.product!.names!.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);
  return { name, description };
}

function adBlob(a: AdRow): string {
  return [a.headline, a.hook, a.body_text, a.transcript, a.name].filter(Boolean).join('\n').trim();
}

/**
 * Score unscored (or force) ads for a project. Caps concurrency to keep cost low.
 */
export async function scoreProjectAdsRelevance(
  projectId: string,
  opts?: { brandId?: number; limit?: number; force?: boolean },
): Promise<{ scored: number; skipped: number; errors: number; avg?: number }> {
  if (!env.openrouterKey && env.judgeEngine === 'jev') {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const limit = Math.min(Math.max(opts?.limit ?? 40, 1), 80);
  let q = supabaseAdmin
    .from('competitor_ads')
    .select('id, brand_id, name, headline, hook, body_text, transcript, relevance_score')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit * 3);

  if (opts?.brandId) q = q.eq('brand_id', opts.brandId);

  const { data, error } = await q;
  if (error) {
    // Column may be missing until migration — retry without relevance_score filter.
    if (/relevance_score|42703|PGRST204/i.test(error.message)) {
      throw new Error('Run supabase-migration-ad-relevance.sql first');
    }
    throw new Error(error.message);
  }

  const rows = ((data || []) as Array<AdRow & { relevance_score?: number | null }>).filter((a) => {
    if (opts?.force) return true;
    return a.relevance_score == null;
  }).slice(0, limit);

  if (!rows.length) return { scored: 0, skipped: (data || []).length, errors: 0 };

  const product = await loadOurProduct(projectId);
  let scored = 0;
  let errors = 0;
  const scores: number[] = [];

  // Sequential / small pool — Jev is cheap but avoid thundering herd.
  const pool = 3;
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      const ad = rows[idx];
      const text = adBlob(ad);
      if (!text || text.length < 12) {
        await supabaseAdmin
          .from('competitor_ads')
          .update({
            relevance_score: 0,
            relevance_label: 'off_target',
            relevance_why: 'No readable ad copy',
            relevance_at: new Date().toISOString(),
          })
          .eq('id', ad.id)
          .eq('project_id', projectId);
        scored++;
        scores.push(0);
        continue;
      }
      try {
        const r = await scoreAdRelevance({
          projectId,
          ourProduct: product.name,
          ourDescription: product.description,
          adText: text,
          pageName: ad.name || undefined,
        });
        const { error: uErr } = await supabaseAdmin
          .from('competitor_ads')
          .update({
            relevance_score: r.score,
            relevance_label: r.label,
            relevance_why: r.why.slice(0, 200),
            relevance_at: new Date().toISOString(),
          })
          .eq('id', ad.id)
          .eq('project_id', projectId);
        if (uErr) throw new Error(uErr.message);
        scored++;
        scores.push(r.score);
      } catch (e) {
        errors++;
        console.warn('[ad-relevance]', ad.id, e instanceof Error ? e.message : e);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(pool, rows.length) }, () => worker()));
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined;
  return { scored, skipped: Math.max(0, (data || []).length - rows.length), errors, avg };
}
