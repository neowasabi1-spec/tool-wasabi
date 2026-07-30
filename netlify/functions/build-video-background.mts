import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getSupabase, run, FFMPEG, makeWorkDir, probeDuration, ttsScene,
  buildSceneVisual, pickShotsForScene, sectionForScene, loadShotPool, materializeShot,
  srtTime, grabThumb, uploadFile,
} from './_shared/video';

/**
 * Background function (up to 15 min) that assembles a NEW video from the
 * project's CLEAN shots + an OpenAI TTS voiceover of the rewritten script +
 * our own burned-in subtitles. Triggered by the build-video enqueue route.
 *
 * Body: { jobId, projectId, brandId, adId }
 * The scenes + voice are read from the video_build_jobs row.
 */

// libass renders an SRT with no [Script Info] against a 384×288 canvas and then
// scales it to the frame, so MarginV below is expressed in that 288-tall space.
const SUB_PLAY_RES_Y = 288;

// Family name inside caption.ttf (Anton). Passed to libass via force_style so it
// matches the bundled font instead of a system font that doesn't exist on Lambda.
const CAPTION_FONT = 'Anton';

/**
 * Absolute path to the bundled caption font. Netlify lays included_files out at
 * their repo-relative path in the function's working directory, but the exact
 * cwd varies, so we probe a few candidates (including one resolved next to this
 * module) and take the first that exists. Returns null if none are found, in
 * which case the burn falls back to whatever font libass can find.
 */
function findCaptionFont(): string | null {
  const candidates = [
    path.join(process.cwd(), 'netlify/functions/_assets/caption.ttf'),
    path.join(process.cwd(), '_assets/caption.ttf'),
  ];
  try { candidates.push(fileURLToPath(new URL('./_assets/caption.ttf', import.meta.url))); } catch { /* not ESM path */ }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/**
 * Where this project's captions sat, as a fraction of frame height (0 = top,
 * 1 = bottom). The subtitle removal recorded each shot's text band in
 * `text_region`; placing the new subtitles on the median of those bands puts
 * them back over the spot the originals were erased from. Defaults to a lower
 * third when nothing was measured.
 */
async function captionBandFraction(
  supabase: ReturnType<typeof getSupabase>, projectId: string,
): Promise<number> {
  const { data } = await supabase
    .from('competitor_shots')
    .select('text_region')
    .eq('project_id', projectId)
    .not('text_region', 'is', null)
    .limit(400);
  const fracs: number[] = [];
  for (const row of (data || []) as { text_region?: string | null }[]) {
    const s = (row.text_region || '').trim();
    if (!s) continue;
    const range = s.match(/(\d*\.?\d+)\s*-\s*(\d*\.?\d+)/);
    if (range) { fracs.push((parseFloat(range[1]) + parseFloat(range[2])) / 2); continue; }
    const kind = s.split(/\s+/)[0].toLowerCase();
    if (kind === 'top') fracs.push(0.15);
    else if (kind === 'center' || kind === 'centre' || kind === 'middle') fracs.push(0.5);
    else if (kind === 'bottom') fracs.push(0.82);
  }
  if (!fracs.length) return 0.72;
  fracs.sort((a, b) => a - b);
  return fracs[Math.floor(fracs.length / 2)];
}
export default async (req: Request) => {
  let body: { jobId?: number; projectId?: string; brandId?: number; adId?: number };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const { jobId, projectId, brandId, adId } = body;
  if (!jobId || !projectId || !brandId || !adId) return new Response('missing fields', { status: 400 });

  const supabase = getSupabase();
  const log = (...a: unknown[]) => console.log('[build-bg]', `job#${jobId}`, ...a);

  const { data: claimed } = await supabase
    .from('video_build_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select('id, scenes, voice')
    .maybeSingle();
  if (!claimed) { log('not pending — skipping'); return new Response('skip', { status: 200 }); }

  const scenes: string[] = (Array.isArray(claimed.scenes) ? claimed.scenes : [])
    .map((s: { text?: string }) => (s && typeof s.text === 'string' ? s.text.trim() : ''))
    .filter(Boolean);
  const voice = claimed.voice || 'alloy';

  const workDir = makeWorkDir('wbuild-');
  try {
    if (scenes.length === 0) throw new Error('no scenes in job');
    // Real-footage pool: shots that never had subtitles plus the AI-cleaned
    // copies. Each clip is used at most once; duration gaps are covered by
    // freezing the last frame, and a shot is only reused as a last resort when
    // the pool is exhausted.
    const pool = await loadShotPool(supabase, projectId);
    const bySection = pool.reduce<Record<string, number>>((acc, s) => {
      acc[s.section] = (acc[s.section] || 0) + 1;
      return acc;
    }, {});
    log(`usable shots (clean + de-subbed): ${pool.length} — ` +
      `hook ${bySection.hook || 0}, body ${bySection.body || 0}, cta ${bySection.cta || 0}`);
    if (pool.length === 0) {
      throw new Error('no shots in the pool — split videos into shots or upload clips in My Footage first');
    }

    const used = new Set<number>();
    const sceneVisuals: string[] = [];
    const sceneAudios: string[] = [];
    const srt: string[] = [];
    let t = 0;
    let fetched = 0;
    for (let i = 0; i < scenes.length; i++) {
      const mp3 = path.join(workDir, `vo_${i}.mp3`);
      await ttsScene(scenes[i], voice, mp3);
      const d = Math.max(0.8, await probeDuration(mp3));
      // Hook footage opens the video, CTA footage closes it, body in between —
      // within that, pick the clips matching this scene's text. No reuse.
      const want = sectionForScene(i, scenes.length);
      let files: string[] = [];
      let have = 0;
      let sections: string[] = [];
      // Only the chosen clips are fetched. A clip that fails to download or
      // normalize is dropped and the scene asks the pool for another one.
      for (let attempt = 0; attempt < 2 && files.length === 0; attempt++) {
        const picked = pickShotsForScene(pool, used, scenes[i], d, want);
        if (picked.clips.length === 0) break;
        sections = picked.sections;
        for (const clip of picked.clips) {
          try {
            files.push(await materializeShot(supabase, clip, workDir, fetched++));
            have += clip.dur;
          } catch (e) {
            log(`scene ${i + 1}: skipping ${clip.key} (${(e as Error).message})`);
          }
        }
      }
      log(`scene ${i + 1}/${scenes.length} wants ${want}, got ${sections.join('+') || 'none'} ` +
        `(${have.toFixed(1)}s of ${d.toFixed(1)}s)`);
      const vis = await buildSceneVisual(files, have, d, workDir, i);
      sceneVisuals.push(vis);
      sceneAudios.push(mp3);
      srt.push(`${i + 1}\n${srtTime(t)} --> ${srtTime(t + d)}\n${scenes[i]}\n`);
      t += d;
    }

    const vList = path.join(workDir, 'v_list.txt');
    fs.writeFileSync(vList, sceneVisuals.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    const visual = path.join(workDir, 'visual.mp4');
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', vList, '-c', 'copy', visual]);

    const aList = path.join(workDir, 'a_list.txt');
    fs.writeFileSync(aList, sceneAudios.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    const voiceFile = path.join(workDir, 'voice.mp3');
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', aList, '-c', 'copy', voiceFile]);

    const base = path.join(workDir, 'base.mp4');
    await run(FFMPEG, [
      '-y', '-i', visual, '-i', voiceFile,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', base,
    ]);

    fs.writeFileSync(path.join(workDir, 'subs.srt'), srt.join('\n'));
    const finalFile = path.join(workDir, 'final.mp4');
    // Sit the subtitles on the band the originals were removed from. Alignment=2
    // anchors at the bottom, so MarginV is the gap up from there: convert the
    // target height fraction into that gap in the 288-tall subtitle canvas.
    const bandFrac = await captionBandFraction(supabase, projectId);
    const marginV = Math.min(250, Math.max(24, Math.round((1 - bandFrac) * SUB_PLAY_RES_Y)));

    // Ship the caption font into a local fonts dir and point libass at it. On
    // Lambda there is no system font, so without this the SRT renders blank.
    let fontStyle = '';
    let fontArg = '';
    const fontSrc = findCaptionFont();
    if (fontSrc) {
      const fontDir = path.join(workDir, 'fonts');
      fs.mkdirSync(fontDir, { recursive: true });
      fs.copyFileSync(fontSrc, path.join(fontDir, 'caption.ttf'));
      fontStyle = `FontName=${CAPTION_FONT},`;
      fontArg = ':fontsdir=fonts';
    } else {
      log('WARNING: caption font not found in bundle — subtitles may not render');
    }
    log(`subtitles on caption band ${bandFrac.toFixed(2)} (MarginV=${marginV}, font=${fontSrc ? CAPTION_FONT : 'system'})`);
    const style =
      `${fontStyle}FontSize=16,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,` +
      `BorderStyle=3,Outline=6,Shadow=0,Alignment=2,MarginV=${marginV}`;
    try {
      await run(FFMPEG, [
        '-y', '-i', base, '-vf', `subtitles=subs.srt${fontArg}:force_style='${style}'`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'copy', finalFile,
      ], { cwd: workDir });
    } catch (e) {
      log(`subtitle burn failed, using base: ${(e as Error).message}`);
      fs.copyFileSync(base, finalFile);
    }

    const thumb = path.join(workDir, 'thumb.jpg');
    try { await grabThumb(finalFile, 1, thumb); } catch { /* ignore */ }

    const stamp = Date.now();
    const clipKey = `${projectId}/generated/${adId}_${stamp}.mp4`;
    const thumbKey = `${projectId}/generated/${adId}_${stamp}.jpg`;
    await uploadFile(supabase, clipKey, finalFile, 'video/mp4');
    let storedThumb = '';
    try { storedThumb = await uploadFile(supabase, thumbKey, thumb, 'image/jpeg'); } catch { /* ignore */ }
    const totalDur = await probeDuration(finalFile);

    const { data: gv } = await supabase
      .from('generated_videos')
      .insert({
        project_id: projectId,
        brand_id: brandId,
        ad_id: adId,
        file_path: clipKey,
        thumb_path: storedThumb || null,
        duration_sec: +totalDur.toFixed(2),
        script: scenes.join('\n'),
        voice,
      })
      .select('id')
      .maybeSingle();

    await supabase
      .from('video_build_jobs')
      .update({ status: 'done', result_id: gv?.id || null, finished_at: new Date().toISOString() })
      .eq('id', jobId);
    log(`done — ${totalDur.toFixed(1)}s`);
    return new Response('done', { status: 200 });
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 1000);
    log('error:', msg);
    await supabase
      .from('video_build_jobs')
      .update({ status: 'error', error: msg, finished_at: new Date().toISOString() })
      .eq('id', jobId);
    return new Response('error', { status: 200 });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
