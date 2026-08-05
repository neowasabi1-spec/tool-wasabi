import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '@/lib/supabase-admin';

/**
 * Shared logic for "recreate a video from the project's real shot pool".
 *
 * The build is driven purely by a script + a voice, never by the source ad, so
 * the same product footage can be reused for any copy and any language: the copy
 * is split into spoken beats (in the chosen language), OpenAI TTS speaks them,
 * and our own subtitles carry the same text. Shots are picked with an ENGLISH
 * "match" hint per beat so footage selection keeps working whatever the spoken
 * language is.
 */

export const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

/** A beat of the build: `text` is spoken + subtitled, `match` steers footage. */
export type BuildScene = { text: string; match: string };

const splitSystem = (language: string) => {
  const langLine = language
    ? `Write every "say" line in ${language}. Localize idioms, currency and phrasing naturally — do NOT translate word for word.`
    : 'Keep every "say" line in the same language as the input script.';
  return `You split a short direct-response video ad script into an ordered list of spoken VOICEOVER beats for a vertical short-form video.

${langLine}

Return ONLY a compact JSON array. Each element is an object:
  { "say": "<the spoken line, ~4-14 words>", "match": "<2-5 ENGLISH keywords for the footage this beat needs, e.g. 'man holding phone'>" }

Rules:
- Each beat = ONE on-screen moment, natural spoken cadence.
- Keep the persuasive order (hook → problem → solution/mechanism → proof → offer → CTA).
- Strip stage directions, brackets, "HOOK:", "CTA:", B-roll notes from "say".
- "match" is ALWAYS in English, whatever the spoken language, so the right footage is chosen.
- 6 to 12 beats total.
No markdown, no explanation.`;
};

/**
 * Split (and optionally localize) a script into build scenes. Falls back to a
 * naive sentence split if the model is unavailable or returns nothing usable;
 * in that case `match` mirrors the spoken text.
 */
export async function splitScriptToScenes(
  script: string,
  language: string,
): Promise<BuildScene[]> {
  const naive = (): BuildScene[] =>
    script
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2)
      .slice(0, 12)
      .map((text) => ({ text, match: text }));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return naive();

  try {
    const anthropic = new Anthropic({ apiKey });
    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1500,
      system: splitSystem(language),
      messages: [{ role: 'user', content: script.slice(0, 6000) }],
    });
    const tb = resp.content.find((b) => b.type === 'text');
    const raw = (tb && 'text' in tb ? tb.text : '') || '';
    const clean = raw.replace(/```json?/gi, '').replace(/```/g, '').trim();
    const arr = JSON.parse(clean);
    if (Array.isArray(arr)) {
      const scenes = arr
        .map((s): BuildScene | null => {
          if (s && typeof s === 'object') {
            const text = String((s as { say?: string }).say || '').trim();
            const match = String((s as { match?: string }).match || '').trim();
            return text ? { text, match: match || text } : null;
          }
          if (typeof s === 'string' && s.trim()) return { text: s.trim(), match: s.trim() };
          return null;
        })
        .filter((s): s is BuildScene => !!s)
        .slice(0, 12);
      if (scenes.length) return scenes;
    }
  } catch {
    /* fall through to naive */
  }
  return naive();
}

/**
 * How many shots in the project are usable footage: never had subtitles, or had
 * them removed by AI inpainting (clean_path). Zero means a build cannot run yet.
 */
export async function countUsableShots(projectId: string): Promise<number> {
  const r = await supabaseAdmin
    .from('competitor_shots')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .or('has_text.is.null,has_text.eq.false,clean_path.not.is.null');
  if (!r.error) return r.count || 0;
  // clean_path column not migrated yet — count truly-clean only.
  const r2 = await supabaseAdmin
    .from('competitor_shots')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .not('has_text', 'is', true);
  return r2.count || 0;
}

/**
 * Insert a build job, tolerating a database that hasn't had the newer optional
 * columns (`language`, `mode`, `source_path`) added yet: if the insert fails
 * because a column is unknown, it retries with only the base columns. Returns
 * null on any other failure.
 */
export async function insertBuildJob(row: {
  project_id: string;
  brand_id: number;
  ad_id: number;
  voice: string;
  scenes: BuildScene[];
  language: string | null;
  mode?: 'build' | 'localize';
  source_path?: string | null;
}): Promise<{ id: number; status: string } | null> {
  const full = { ...row, status: 'pending' as const };
  let res = await supabaseAdmin.from('video_build_jobs').insert(full).select('id, status').single();
  if (res.error && /language|mode|source_path|column/i.test(res.error.message)) {
    // Older schema: keep only the columns that have always existed.
    const baseOnly = {
      project_id: row.project_id, brand_id: row.brand_id, ad_id: row.ad_id,
      voice: row.voice, scenes: row.scenes, status: 'pending' as const,
    };
    res = await supabaseAdmin.from('video_build_jobs').insert(baseOnly).select('id, status').single();
  }
  if (res.error || !res.data) return null;
  return res.data as { id: number; status: string };
}

/**
 * Fire an ffmpeg+TTS background function (fire-and-forget; it responds 202).
 * `fn` selects the assembler: 'build-video-background' composes from the shot
 * pool, 'localize-video-background' dubs an existing video.
 */
export async function triggerBuildBackground(
  origin: string,
  payload: { jobId: number; projectId: string; brandId: number; adId: number },
  fn: 'build-video-background' | 'localize-video-background' = 'build-video-background',
): Promise<void> {
  try {
    await fetch(`${origin}/.netlify/functions/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('[build-video] background trigger failed:', (e as Error).message);
  }
}

/** Normalize an arbitrary voice input to a supported OpenAI voice. */
export function normalizeVoice(v: unknown): string {
  return OPENAI_VOICES.includes(String(v)) ? String(v) : 'alloy';
}

/** Trim a free-text language label to a safe, short string (or '' for none). */
export function normalizeLanguage(v: unknown): string {
  return String(v ?? '').trim().slice(0, 40);
}
