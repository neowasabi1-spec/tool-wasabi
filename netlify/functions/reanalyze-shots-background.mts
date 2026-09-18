import fs from 'fs';
import path from 'path';
import { getSupabase, analyzeShot, downloadSource, makeWorkDir, autoCleanShots, selfOrigin } from './_shared/video';

/**
 * Background function that re-runs the Vision analysis on LEGACY shots:
 * shots saved before tagging existed (empty tags), subtitled shots whose
 * text band was never measured, or shots missing scene JSON (action /
 * people / context). With a measured band the video builder can crop the
 * subtitle strip away; with scene JSON it can match footage to copy by
 * meaning instead of tags.
 *
 * Triggered fire-and-forget by GET /api/projecthub/projects/:id/shots when it
 * spots legacy rows. Idempotent: after one pass every shot has tags + band +
 * action, so it stops re-triggering.
 *
 * Body: { projectId }
 */

const BAND_RE = /[01]?\.\d+-[01]?\.\d+/;

type ShotRow = {
  id: number;
  ad_id: number;
  thumb_path?: string | null;
  end_sec?: number | null;
  start_sec?: number | null;
  has_text?: boolean | null;
  text_region?: string | null;
  text_score?: number | null;
  tags?: string[] | null;
  section?: string | null;
  action?: string | null;
};

const CLEAN_RESCORE = 0.92;

function needsReanalysis(s: ShotRow, hasActionCol: boolean): boolean {
  if (!s.thumb_path) return false;
  if (!Array.isArray(s.tags) || s.tags.length === 0) return true;
  if (s.has_text === true && !BAND_RE.test(s.text_region || '')) return true;
  if (hasActionCol && !String(s.action || '').trim()) return true;
  // Old detector ignored CapCut/TikTok captions and stamped CLEAN (score ~0.1).
  if (s.has_text !== true) {
    const score = Number(s.text_score);
    if (!Number.isFinite(score) || score < CLEAN_RESCORE) return true;
  }
  return false;
}

/** Default band per region so a shot never stays band-less (avoids re-trigger loops). */
function fallbackBand(region: string): string {
  const r = region.toLowerCase();
  if (r.startsWith('bottom')) return `bottom 0.70-0.95`;
  if (r.startsWith('top')) return `top 0.05-0.25`;
  return `${r || 'center'} 0.40-0.60`;
}

export default async (req: Request) => {
  let body: { projectId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const projectId = body.projectId;
  if (!projectId) return new Response('missing projectId', { status: 400 });

  const supabase = getSupabase();
  const log = (...a: unknown[]) => console.log('[reanalyze-bg]', projectId, ...a);

  const full =
    'id, ad_id, thumb_path, start_sec, end_sec, has_text, text_region, text_score, tags, section, action';
  const base =
    'id, ad_id, thumb_path, start_sec, end_sec, has_text, text_region, text_score, tags, section';
  let { data, error } = await supabase
    .from('competitor_shots')
    .select(full)
    .eq('project_id', projectId)
    .limit(200);
  let hasActionCol = true;
  if (error && /action/i.test(error.message || '')) {
    hasActionCol = false;
    ({ data } = await supabase
      .from('competitor_shots')
      .select(base)
      .eq('project_id', projectId)
      .limit(200));
  }
  const shots = (data || []) as ShotRow[];
  const allLegacy = shots.filter((s) => needsReanalysis(s, hasActionCol));
  // Cap per run so we stay inside the 15-min budget; leftover CLEAN shots
  // still have a low text_score and will be picked up on the next listing.
  const legacy = allLegacy.slice(0, 40);
  log(`shots: ${shots.length}, to re-analyze: ${allLegacy.length} (doing ${legacy.length})`);
  if (legacy.length === 0) return new Response('nothing to do', { status: 200 });

  // Approximate source duration per ad (for recomputing missing sections).
  const adEnd: Record<number, number> = {};
  for (const s of shots) {
    const e = Number(s.end_sec) || 0;
    if (e > (adEnd[s.ad_id] || 0)) adEnd[s.ad_id] = e;
  }

  const workDir = makeWorkDir('wreana-');
  let updated = 0;
  const newlySubtitled: number[] = [];
  try {
    for (const s of legacy) {
      const thumbFile = path.join(workDir, `t_${s.id}.jpg`);
      try {
        await downloadSource(supabase, s.thumb_path as string, thumbFile);
      } catch (e) {
        log(`shot #${s.id}: thumb download failed — ${(e as Error).message}`);
        continue;
      }

      const meta = await analyzeShot(thumbFile);
      try { fs.rmSync(thumbFile, { force: true }); } catch { /* ignore */ }
      if (meta.hasText === null) {
        log(`shot #${s.id}: vision failed, skipping`);
        continue;
      }

      let region = meta.region;
      if (meta.hasText && !BAND_RE.test(region)) region = fallbackBand(region);

      const patch: Record<string, unknown> = {
        has_text: meta.hasText,
        text_score: meta.score,
        text_region: meta.hasText ? region : '',
        label: meta.label || null,
        caption: meta.caption || null,
        tags: meta.tags.length > 0 ? meta.tags : ['unclassified'],
        action: meta.action || null,
        people_count: meta.peopleCount,
        people: meta.people || null,
        context: meta.context || null,
        scene: {
          action: meta.action,
          peopleCount: meta.peopleCount,
          people: meta.people,
          context: meta.context,
        },
      };

      // Fill a missing section from the shot's position in its source video.
      if (!s.section && adEnd[s.ad_id] > 0) {
        const total = adEnd[s.ad_id];
        const mid = ((Number(s.start_sec) || 0) + (Number(s.end_sec) || 0)) / 2;
        patch.section = mid <= Math.min(5, total * 0.18) ? 'hook' : mid >= total * 0.82 ? 'cta' : 'body';
      }

      let { error: updErr } = await supabase.from('competitor_shots').update(patch).eq('id', s.id);
      if (updErr && /action|people_count|people|context|scene/i.test(updErr.message)) {
        delete patch.action; delete patch.people_count; delete patch.people;
        delete patch.context; delete patch.scene;
        ({ error: updErr } = await supabase.from('competitor_shots').update(patch).eq('id', s.id));
      }
      if (updErr) log(`shot #${s.id}: update failed — ${updErr.message}`);
      else {
        updated++;
        if (meta.hasText && s.has_text !== true) newlySubtitled.push(s.id);
        log(`shot #${s.id}: ${meta.hasText ? region : 'clean'} — ${meta.action || meta.label || '(no scene)'}`);
      }
    }
    if (newlySubtitled.length) {
      const queued = await autoCleanShots(supabase, selfOrigin(req.url), projectId, newlySubtitled);
      log(queued
        ? `queued AI subtitle removal for ${queued} newly flagged shots`
        : `${newlySubtitled.length} subtitled shots left for manual cleanup`);
    }
    log(`done — updated ${updated}/${legacy.length}`);
    return new Response('done', { status: 200 });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
