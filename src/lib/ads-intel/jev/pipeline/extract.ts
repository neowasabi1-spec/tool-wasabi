import { z } from 'zod';
import { loadProject } from '../brain';
import { db, must } from '../db';
import { env } from '../env';
import { enqueue, progress } from '../jobs';
import { chatJson, embed, looseBool as B, looseNumber as N, looseString as S, looseStringArray as SA, type ContentPart } from '../openrouter';
import { getMedia, signedUrls } from '../storage';
import type { Creative } from '../types';
import { toPg } from '../vectors';
import { assignCreative } from './assign';

const TextX = z.object({
  advertised_product: S,
  language: S,
  text_en: S,
  summary: S,
});

const ImageX = z.object({
  advertised_product: S,
  subject: S,
  setting: S,
  composition: S,
  on_image_text: SA,
  on_image_text_en: SA,
  dominant_colors_named: SA,
  logo: z.object({ present: B, position: S, color: S, intact: B }),
  product_visible: B,
  product_treatment: S,
  people: S,
  mood: S,
  format_guess: S,
  description: S,
});

const Shot = z.object({ start_s: N, end_s: N, visual: S, on_screen_text: S, audio: S });

const VideoX = z.object({
  advertised_product: S,
  language: S,
  duration_s: N,
  transcript: S,
  transcript_en: S,
  shots: z.array(Shot),
  hook: z.object({ start_s: N, end_s: N, visual: S, audio: S, on_screen_text: S, summary: S }),
  message: z.object({
    start_s: N, end_s: N,
    angle: S, promise: S, mechanism: S, proof: S,
    claims: SA, cta: S, summary: S,
  }),
  visual_format: z.object({ type: S, cut_rhythm: S, production_level: S, people: S, music: S, summary: S }),
  dominant_colors_named: SA,
  logo: z.object({ present: B, position: S }),
  description: S,
});

export type VideoExtraction = z.infer<typeof VideoX>;

const VIDEO_MIME: Record<string, string> = { mp4: 'video/mp4', mov: 'video/mov', webm: 'video/webm' };

async function videoDataUrl(path: string): Promise<string> {
  const buf = await getMedia(path);
  const ext = path.split('.').pop() ?? 'mp4';
  return `data:${VIDEO_MIME[ext] ?? 'video/mp4'};base64,${buf.toString('base64')}`;
}

const advertisedLine = (p: string | null) => (p ? `Advertised product: ${p}\n` : '');

const copyText = (c: Creative) =>
  [
    c.bodies.length ? `Primary text:\n${c.bodies.join('\n---\n')}` : '',
    c.titles.length ? `Headline: ${c.titles.join(' | ')}` : '',
    c.descriptions.length ? `Description: ${c.descriptions.join(' | ')}` : '',
    c.captions.length ? `Link caption: ${c.captions.join(' | ')}` : '',
  ].filter(Boolean).join('\n');

const SYSTEM = `You analyse Facebook/Instagram ads for a creative strategist.
Be literal and specific: describe what is actually there. Name colours with plain names (e.g. "navy blue", "sand"), never hex.
Write every descriptive field in English; keep transcripts in the original language and also give the English version.
Answer with a single JSON object matching the requested shape.`;

/** Converte una creatività (testo / immagine / carosello / video) in una descrizione testuale strutturata. */
export async function extractCreative(creativeId: string, jobId?: string) {
  const c = must(await db().from('jev_creatives').select('*').eq('id', creativeId).single()) as Creative;
  const project = await loadProject(c.project_id);
  await db().from('jev_creatives').update({ extraction_status: 'running', extraction_error: null }).eq('id', creativeId);

  try {
    const urls = await signedUrls(c.media_paths, 3600);
    const copy = copyText(c);
    const brandHint = `Brand of reference (for colour naming only): palette ${project.palette.join(', ') || 'n/a'}.`;
    let extraction: unknown;
    let descriptionEn: string;
    let sections: { section: 'hook' | 'message' | 'visual_format'; start_s: number | null; end_s: number | null; content: unknown; text: string }[] = [];

    if (c.media_type === 'video' && c.media_paths.length) {
      await progress(jobId, 'Analisi video (trascrizione, shot, sezioni)');
      const v = await chatJson({
        model: env.visionModel, purpose: 'extract:video', projectId: c.project_id, temperature: 0.2, maxTokens: 12000,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              // Gemini su OpenRouter accetta URL video solo da YouTube: il file va inviato in base64
              { type: 'video_url', video_url: { url: await videoDataUrl(c.media_paths[0]) } },
              {
                type: 'text',
                text: `${brandHint}\nAd copy that runs with this video:\n${copy || '(none)'}\n\n` +
                  `Return JSON with keys: advertised_product (brand and product name as shown, or ""), language, duration_s, transcript, transcript_en, shots[{start_s,end_s,visual,on_screen_text,audio}] (at most 20 shots: merge very short cuts), ` +
                  `hook{start_s,end_s,visual,audio,on_screen_text,summary} (the opening that must stop the scroll — decide its real length from the content, do not assume 3 seconds), ` +
                  `message{start_s,end_s,angle,promise,mechanism,proof,claims[],cta,summary}, ` +
                  `visual_format{type,cut_rhythm,production_level,people,music,summary}, dominant_colors_named[], logo{present,position}, description.`,
              },
            ] as ContentPart[],
          },
        ],
      }, VideoX);
      extraction = v;
      sections = [
        { section: 'hook', start_s: v.hook.start_s, end_s: v.hook.end_s, content: v.hook, text: `HOOK (${v.hook.start_s}-${v.hook.end_s}s)\nVisual: ${v.hook.visual}\nAudio: ${v.hook.audio}\nOn-screen text: ${v.hook.on_screen_text}\n${v.hook.summary}` },
        { section: 'message', start_s: v.message.start_s, end_s: v.message.end_s, content: v.message, text: `MESSAGE\nAngle: ${v.message.angle}\nPromise: ${v.message.promise}\nMechanism: ${v.message.mechanism}\nProof: ${v.message.proof}\nClaims: ${v.message.claims.join('; ')}\nCTA: ${v.message.cta}\n${v.message.summary}` },
        { section: 'visual_format', start_s: null, end_s: null, content: v.visual_format, text: `VISUAL FORMAT\nType: ${v.visual_format.type}\nCut rhythm: ${v.visual_format.cut_rhythm}\nProduction: ${v.visual_format.production_level}\nPeople: ${v.visual_format.people}\nMusic: ${v.visual_format.music}\n${v.visual_format.summary}` },
      ];
      descriptionEn = [
        `VIDEO AD, ${v.duration_s}s, language ${v.language}`,
        sections.map((s) => s.text).join('\n\n'),
        `Transcript (EN): ${v.transcript_en}`,
        copy ? `Ad copy:\n${copy}` : '',
      ].filter(Boolean).join('\n\n');
    } else if ((c.media_type === 'image' || c.media_type === 'carousel') && c.media_paths.length) {
      await progress(jobId, `Analisi ${c.media_type === 'carousel' ? 'carosello' : 'immagine'}`);
      const cards = [];
      for (const path of c.media_paths) {
        cards.push(await chatJson({
          model: env.visionModel, purpose: 'extract:image', projectId: c.project_id, temperature: 0.2, maxTokens: 2500,
          messages: [
            { role: 'system', content: SYSTEM },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: urls[path] } },
                {
                  type: 'text',
                  text: `${brandHint}\nAd copy that runs with this image:\n${copy || '(none)'}\n\n` +
                    `Return JSON with keys: advertised_product (brand and product name as shown, or ""), subject, setting, composition, on_image_text[], on_image_text_en[], dominant_colors_named[], ` +
                    `logo{present,position,color,intact}, product_visible, product_treatment, people, mood, format_guess, description.`,
                },
              ] as ContentPart[],
            },
          ],
        }, ImageX));
      }
      extraction = c.media_type === 'carousel' ? { cards } : cards[0];
      const cardText = (x: z.infer<typeof ImageX>, i?: number) =>
        `${i !== undefined ? `CARD ${i + 1}\n` : ''}Subject: ${x.subject}\nSetting: ${x.setting}\nComposition: ${x.composition}\nOn-image text (EN): ${x.on_image_text_en.join(' / ') || 'none'}\nColours: ${x.dominant_colors_named.join(', ')}\nLogo: ${x.logo.present ? `${x.logo.position}, ${x.logo.color}, ${x.logo.intact ? 'intact' : 'altered'}` : 'absent'}\nProduct: ${x.product_visible ? x.product_treatment : 'not visible'}\nPeople: ${x.people}\nMood: ${x.mood}\nFormat: ${x.format_guess}\n${x.description}`;
      descriptionEn = [
        c.media_type === 'carousel' ? `CAROUSEL AD, ${cards.length} cards (read as a sequence)` : 'STATIC IMAGE AD',
        cards.map((x, i) => cardText(x, c.media_type === 'carousel' ? i : undefined)).join('\n\n'),
        copy ? `Ad copy:\n${copy}` : '',
      ].filter(Boolean).join('\n\n');
    } else {
      await progress(jobId, 'Analisi testo');
      const t = await chatJson({
        model: env.visionModel, purpose: 'extract:text', projectId: c.project_id, temperature: 0.2, maxTokens: 2000,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Ad copy:\n${copy || '(empty)'}\n\nReturn JSON with keys: advertised_product (brand and product name, or ""), language, text_en (faithful English translation), summary (angle, promise, claims, CTA).` },
        ],
      }, TextX);
      extraction = t;
      descriptionEn = `TEXT AD (media not available), language ${t.language}\n${t.summary}\n\nCopy (EN):\n${t.text_en}`;
    }

    const texts = [descriptionEn, ...sections.map((s) => s.text)];
    const vecs = await embed(texts, 'embed:creative', c.project_id);
    const ex = extraction as { advertised_product?: string; cards?: { advertised_product?: string }[] };
    const advertised = ex.advertised_product || ex.cards?.find((x) => x.advertised_product)?.advertised_product || null;
    await db().from('jev_creatives').update({
      extraction, advertised_product: advertised, description_en: advertisedLine(advertised) + descriptionEn, embedding: toPg(vecs[0]), extraction_status: c.media_paths.length || c.media_type === 'text' ? 'done' : 'no_media',
    }).eq('id', creativeId);
    await db().from('jev_creative_sections').delete().eq('creative_id', creativeId);
    if (sections.length) {
      await db().from('jev_creative_sections').insert(sections.map((s, i) => ({ creative_id: creativeId, ...s, embedding: toPg(vecs[i + 1]) })));
    }

    if (!c.product_id) await assignCreative(creativeId);
    await enqueue('analyze_creative', { creativeId }, c.project_id);
    return { ok: true, media_type: c.media_type, sections: sections.length };
  } catch (e) {
    await db().from('jev_creatives').update({ extraction_status: 'error', extraction_error: e instanceof Error ? e.message : String(e) }).eq('id', creativeId);
    throw e;
  }
}
