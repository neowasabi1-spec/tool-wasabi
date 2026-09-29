/**
 * Jev (or Claude fallback) scores scraped ads against OUR product.
 * Used for vertical peers and competitor spy: is this ad usable inspiration?
 */

import sharp from 'sharp';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadDiscoveryLexicon } from '@/lib/discovery-lexicon';
import { buildState, engine, norm } from '@/lib/ads-intel/jev/judge';
import type { QuestionSet } from '@/lib/ads-intel/jev/judge/types';
import { env } from '@/lib/ads-intel/jev/env';
import { chatJson, type ContentPart } from '@/lib/ads-intel/jev/openrouter';
import { getMedia } from '@/lib/ads-intel/jev/storage';

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
      question: 'Would someone evaluating `our_product` also reasonably consider the offer described in `ad`?',
      focus: 'Same buyer problem and offer TYPE. For make-money / phone-income info products, peers are other ClickBank-style income systems (e.g. Wifi Profits) — NOT real estate, local services, hardware, SaaS, hotels, or anything that only shares a keyword like "profit" or "$".',
    },
    criteria: {
      true: {
        what: 'Same vertical / buyer intent (comparable info product or SKU a media buyer would spy for creative parallels).',
        not_for: 'Real estate, realtors, mortgages, local services, WiFi routers/ISPs, SaaS tools, shops, hotels, unrelated categories that share a keyword.',
        examples: ['Wifi Profits when we sell Social Profits Machine', 'another slim-coffee brand when we sell a slim coffee'],
      },
      false: {
        what: 'Different product category — buyer of ours would not compare this offer.',
        examples: ['Keep The Green Realty / realtor ads', 'WiFi router ads', 'hotel booking', 'CapCut tutorial', 'marketplace'],
      },
    },
  },
  inspiration_value: {
    type: 'score',
    instructions: {
      question: 'How useful is `ad` as creative inspiration for ads promoting `our_product`?',
      focus: 'Only score high if the OFFER is in the same vertical. A well-made real-estate creative is still 0 for a phone-income offer.',
    },
    criteria: [
      { what: 'Off-target or useless for our creatives', examples: ['real estate', 'wrong category', 'no readable offer'] },
      { what: 'Loosely related — same niche vibe but weak transfer', examples: ['generic make-money fluff'] },
      { what: 'Strong peer — angles/hooks/formats we could adapt', examples: ['Wifi Profits phone-income VSL angles for Social Profits Machine'] },
    ],
  },
};

function labelFrom(score: number, comparable: boolean): RelevanceLabel {
  if (!comparable || score < 45) return 'off_target';
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
  visualSummary?: string;
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
      opts.pageName ? `Page / advertiser: ${opts.pageName}` : '',
      opts.visualSummary ? `What the creative shows (vision): ${opts.visualSummary}` : '',
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
  // Stricter than 0.45 — keyword collisions ("profit", "$") must not pass.
  const comparable = pTrue >= 0.55;
  const inspNorm = norm(insp);
  const score = Math.round(
    100 * Math.max(0, Math.min(1, 0.5 * pTrue + 0.5 * (comparable ? inspNorm : inspNorm * 0.2))),
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
  file_path?: string | null;
  media_type?: string | null;
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

async function frameFromVideo(buf: Buffer): Promise<Buffer | null> {
  try {
    const { spawn } = await import('child_process');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const ffmpegStatic = (await import('ffmpeg-static')).default;
    const bin = typeof ffmpegStatic === 'string' ? ffmpegStatic : '';
    if (!bin || !fs.existsSync(bin)) return null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-frame-'));
    const src = path.join(dir, 'in.bin');
    const out = path.join(dir, 'frame.jpg');
    try {
      fs.writeFileSync(src, buf);
      await new Promise<void>((resolve, reject) => {
        const p = spawn(bin, ['-y', '-ss', '0.3', '-i', src, '-frames:v', '1', '-q:v', '3', out], { stdio: 'ignore' });
        const timer = setTimeout(() => {
          p.kill('SIGKILL');
          reject(new Error('ffmpeg timeout'));
        }, 20000);
        p.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        p.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg ${code}`));
        });
      });
      return fs.existsSync(out) ? fs.readFileSync(out) : null;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[ad-relevance] frame:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** Vision pass when copy is thin — Meta often stores almost no text for graphic ads. */
async function visualOfferSummary(
  filePath: string,
  projectId: string,
  mediaType?: string | null,
): Promise<string> {
  if (!filePath || /^https?:\/\//i.test(filePath)) return '';
  try {
    const buf = await getMedia(filePath);
    const isVideo = /video|mp4|webm|mov/i.test(String(mediaType || '')) || /\.(mp4|webm|mov)($|\?)/i.test(filePath);
    let img = buf;
    if (isVideo) {
      const frame = await frameFromVideo(buf);
      if (!frame) return '';
      img = frame;
    }
    const small = await sharp(img).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
    const url = `data:image/jpeg;base64,${small.toString('base64')}`;
    const parts: ContentPart[] = [
      {
        type: 'text',
        text: 'Look at this Facebook ad creative. Answer with one JSON object {sold, category, brand} — what product/service is being sold, category in 2-4 words, brand if visible. Be literal (e.g. real estate / realtor is not "make money online").',
      },
      { type: 'image_url', image_url: { url } },
    ];
    const r = await chatJson(
      {
        model: env.visionModel,
        purpose: 'ad_relevance_vision',
        projectId,
        temperature: 0,
        maxTokens: 200,
        messages: [{ role: 'user', content: parts }],
      },
      z.object({
        sold: z.string(),
        category: z.string(),
        brand: z.string().optional(),
      }),
    );
    return [r.brand && `Brand: ${r.brand}`, `Category: ${r.category}`, `Sells: ${r.sold}`].filter(Boolean).join('. ');
  } catch (e) {
    console.warn('[ad-relevance] vision:', e instanceof Error ? e.message : e);
    return '';
  }
}

async function fetchAdsForScoring(
  projectId: string,
  opts: { brandId?: number; limit: number },
): Promise<AdRow[]> {
  const base = () => {
    let q = supabaseAdmin
      .from('competitor_ads')
      .select('id, brand_id, name, headline, hook, body_text, file_path, media_type, relevance_score')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(opts.limit * 3);
    if (opts.brandId) q = q.eq('brand_id', opts.brandId);
    return q;
  };

  // Prefer including transcript when the column exists.
  let withTranscript = supabaseAdmin
    .from('competitor_ads')
    .select('id, brand_id, name, headline, hook, body_text, transcript, file_path, media_type, relevance_score')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(opts.limit * 3);
  if (opts.brandId) withTranscript = withTranscript.eq('brand_id', opts.brandId);

  const first = await withTranscript;
  if (!first.error) return (first.data || []) as AdRow[];
  if (!/transcript|42703|PGRST204/i.test(first.error.message || '')) {
    if (/relevance_score|42703|PGRST204/i.test(first.error.message || '')) {
      throw new Error('Run supabase-migration-ad-relevance.sql first');
    }
    throw new Error(first.error.message);
  }
  const second = await base();
  if (second.error) {
    if (/relevance_score|42703|PGRST204/i.test(second.error.message || '')) {
      throw new Error('Run supabase-migration-ad-relevance.sql first');
    }
    throw new Error(second.error.message);
  }
  return (second.data || []) as AdRow[];
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
  const data = await fetchAdsForScoring(projectId, { brandId: opts?.brandId, limit });

  const rows = (data as Array<AdRow & { relevance_score?: number | null }>).filter((a) => {
    if (opts?.force) return true;
    return a.relevance_score == null;
  }).slice(0, limit);

  if (!rows.length) return { scored: 0, skipped: data.length, errors: 0 };

  const product = await loadOurProduct(projectId);
  let scored = 0;
  let errors = 0;
  const scores: number[] = [];

  const pool = 2;
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      const ad = rows[idx];
      let text = adBlob(ad);
      let visualSummary = '';
      if ((text.length < 80 || /\{\{/.test(text)) && ad.file_path) {
        visualSummary = await visualOfferSummary(ad.file_path, projectId, ad.media_type);
      }
      if ((!text || text.length < 12) && !visualSummary) {
        await supabaseAdmin
          .from('competitor_ads')
          .update({
            relevance_score: 0,
            relevance_label: 'off_target',
            relevance_why: 'No readable ad copy or visual offer',
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
          adText: text || '(see visual summary)',
          pageName: ad.name || undefined,
          visualSummary: visualSummary || undefined,
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
  return { scored, skipped: Math.max(0, data.length - rows.length), errors, avg };
}

/**
 * Drain unscored ads across ALL projects (scheduled cron + post-scrape).
 */
export async function scoreAllProjectsUnscoredAds(opts?: {
  perProjectLimit?: number;
  maxProjects?: number;
  maxAds?: number;
  force?: boolean;
}): Promise<{
  projects: number;
  scored: number;
  errors: number;
  details: Array<{ projectId: string; scored: number; errors: number; avg?: number }>;
}> {
  const perProjectLimit = Math.min(Math.max(opts?.perProjectLimit ?? 30, 1), 60);
  const maxProjects = Math.min(Math.max(opts?.maxProjects ?? 25, 1), 50);
  const maxAds = Math.min(Math.max(opts?.maxAds ?? 120, 1), 200);

  let q = supabaseAdmin
    .from('competitor_ads')
    .select('project_id')
    .order('created_at', { ascending: false })
    .limit(800);
  if (!opts?.force) q = q.is('relevance_score', null);

  const { data, error } = await q;

  if (error) {
    if (/relevance_score|42703|PGRST204/i.test(error.message)) {
      throw new Error('Run supabase-migration-ad-relevance.sql first');
    }
    throw new Error(error.message);
  }

  const counts = new Map<string, number>();
  for (const row of data || []) {
    const pid = String((row as { project_id?: string }).project_id || '');
    if (!pid) continue;
    counts.set(pid, (counts.get(pid) || 0) + 1);
  }

  const projectIds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxProjects)
    .map(([id]) => id);

  let scored = 0;
  let errors = 0;
  const details: Array<{ projectId: string; scored: number; errors: number; avg?: number }> = [];

  for (const projectId of projectIds) {
    if (scored >= maxAds) break;
    const room = Math.max(1, Math.min(perProjectLimit, maxAds - scored));
    try {
      const r = await scoreProjectAdsRelevance(projectId, { limit: room, force: !!opts?.force });
      scored += r.scored;
      errors += r.errors;
      details.push({ projectId, scored: r.scored, errors: r.errors, avg: r.avg });
    } catch (e) {
      errors++;
      console.warn('[ad-relevance] project', projectId, e instanceof Error ? e.message : e);
      details.push({ projectId, scored: 0, errors: 1 });
    }
  }

  return { projects: details.length, scored, errors, details };
}
