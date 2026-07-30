import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getSupabase, run, FFMPEG, makeWorkDir, probeDuration, ttsScene,
  buildSceneVisual, pickShotsForScene, sectionForScene, loadShotPool, materializeShot,
  grabThumb, uploadFile, TARGET_W, TARGET_H,
} from './_shared/video';

/**
 * Background function (up to 15 min) that assembles a NEW video from the
 * project's CLEAN shots + an OpenAI TTS voiceover of the rewritten script +
 * our own burned-in subtitles. Triggered by the build-video enqueue route.
 *
 * Body: { jobId, projectId, brandId, adId }
 * The scenes + voice are read from the video_build_jobs row.
 */

// Family name inside caption.ttf (Anton), used as the ASS style Fontname so
// libass matches the bundled font instead of a system font that doesn't exist
// on Lambda.
const CAPTION_FONT = 'Anton';

// Median caption band used when a scene's own shots carry no measured position.
const DEFAULT_BAND = 0.72;

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

/** Project-wide median caption band, used as the fallback for scenes whose own
 * shots carry no measured position. */
function medianBand(values: number[]): number {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return DEFAULT_BAND;
  return v[Math.floor(v.length / 2)];
}

/** ASS timestamp: H:MM:SS.CS (centiseconds). */
function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${h}:${p(m)}:${p(s)}.${p(c)}`;
}

/** Wrap a caption into short lines joined by ASS line breaks (\N). */
function wrapCaption(text: string, maxChars = 24): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line.length + 1 + w.length) > maxChars) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines
    .join('\\N')
    // ASS treats { } as override blocks — neutralise any that appear in copy.
    .replace(/\{/g, '(').replace(/\}/g, ')');
}

/**
 * Build an ASS subtitle file. Each cue is anchored (\an5 = centre) at the
 * vertical band its scene's footage originally carried its caption on, so the
 * new subtitle lands exactly where the old one was erased. PlayRes matches the
 * real output frame, so positions are in true pixels.
 */
function buildAss(cues: { start: number; end: number; text: string; band: number }[]): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${TARGET_W}`,
    `PlayResY: ${TARGET_H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, ' +
      'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // BorderStyle=3 = opaque box (OutlineColour is the box colour). White text,
    // black box, centred anchor. Fontsize is in the 1920-tall PlayRes space.
    `Style: Default,${CAPTION_FONT},80,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,` +
      '1,0,0,0,100,100,0,0,3,16,0,5,40,40,40,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = cues.map((c) => {
    const y = Math.min(TARGET_H - 120, Math.max(120, Math.round(c.band * TARGET_H)));
    const x = Math.round(TARGET_W / 2);
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,` +
      `{\\an5\\pos(${x},${y})}${wrapCaption(c.text)}`;
  });
  return [...header, ...events].join('\n') + '\n';
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

    // Project-wide fallback band for scenes whose shots were never measured.
    const projectBand = medianBand(
      pool.map((s) => s.band).filter((b): b is number => typeof b === 'number'),
    );

    const used = new Set<number>();
    const sceneVisuals: string[] = [];
    const sceneAudios: string[] = [];
    const cues: { start: number; end: number; text: string; band: number }[] = [];
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
      const sceneBands: number[] = [];
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
            if (typeof clip.band === 'number') sceneBands.push(clip.band);
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
      // Put this cue on the band its own footage carried; otherwise fall back to
      // the project median so it still lands where captions generally were.
      const band = sceneBands.length ? medianBand(sceneBands) : projectBand;
      cues.push({ start: t, end: t + d, text: scenes[i], band });
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

    // Each cue is positioned on the band its own scene's footage originally
    // carried its caption on (see buildAss), so the new subtitle lands where the
    // old one was erased. PlayRes = real frame, positions are in true pixels.
    fs.writeFileSync(path.join(workDir, 'subs.ass'), buildAss(cues));
    const finalFile = path.join(workDir, 'final.mp4');

    // Ship the caption font into a local fonts dir and point libass at it. On
    // Lambda there is no system font, so without this the ASS renders blank.
    let fontArg = '';
    const fontSrc = findCaptionFont();
    if (fontSrc) {
      const fontDir = path.join(workDir, 'fonts');
      fs.mkdirSync(fontDir, { recursive: true });
      fs.copyFileSync(fontSrc, path.join(fontDir, 'caption.ttf'));
      fontArg = ':fontsdir=fonts';
    } else {
      log('WARNING: caption font not found in bundle — subtitles may not render');
    }
    const bands = cues.map((c) => c.band.toFixed(2)).join(',');
    log(`subtitles: ${cues.length} cues on bands [${bands}] (font=${fontSrc ? CAPTION_FONT : 'system'})`);
    try {
      await run(FFMPEG, [
        '-y', '-i', base, '-vf', `ass=subs.ass${fontArg}`,
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
