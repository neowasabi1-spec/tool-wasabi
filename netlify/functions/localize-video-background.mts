import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getSupabase, run, FFMPEG, makeWorkDir, probeDuration, ttsScene,
  normalizeShot, downloadSource, grabThumb, uploadFile, TARGET_W, TARGET_H,
} from './_shared/video';

/**
 * Background function that LOCALIZES an existing creative video: it keeps the
 * original footage, replaces the audio with a translated voiceover, and burns
 * our own subtitles in the target language. No shot pool — the visual is the
 * source video itself, looped or trimmed to the voiceover length.
 *
 * Triggered by the ads/[adId]/build-video route with mode 'localize'.
 * Body: { jobId, projectId, brandId, adId }
 */

const CAPTION_FONT = 'Anton';
// Localized subtitles sit low, where short-form captions usually live. The
// original burned-in caption (if any) is the user's call to clean in Shots.
const SUB_BAND = 0.82;

function findCaptionFont(): string | null {
  const candidates = [
    path.join(process.cwd(), 'netlify/functions/_assets/caption.ttf'),
    path.join(process.cwd(), '_assets/caption.ttf'),
  ];
  try { candidates.push(fileURLToPath(new URL('./_assets/caption.ttf', import.meta.url))); } catch { /* not ESM */ }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${h}:${p(m)}:${p(s)}.${p(c)}`;
}

function wrapCaption(text: string, maxChars = 24): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line.length + 1 + w.length) > maxChars) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join('\\N').replace(/\{/g, '(').replace(/\}/g, ')');
}

function buildAss(cues: { start: number; end: number; text: string }[]): string {
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
    // Outline + soft shadow, no background box (BorderStyle=1): white text, thick
    // black outline, semi-transparent shadow so it reads on any footage.
    `Style: Default,${CAPTION_FONT},80,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,` +
      '1,0,0,0,100,100,0,0,1,5,3,5,40,40,40,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const y = Math.round(SUB_BAND * TARGET_H);
  const x = Math.round(TARGET_W / 2);
  const events = cues.map((c) =>
    `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,` +
    `{\\an5\\pos(${x},${y})}${wrapCaption(c.text)}`);
  return [...header, ...events].join('\n') + '\n';
}

export default async (req: Request) => {
  let body: { jobId?: number; projectId?: string; brandId?: number; adId?: number };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const { jobId, projectId } = body;
  const brandId = body.brandId || 0;
  const adId = body.adId || 0;
  if (!jobId || !projectId) return new Response('missing fields', { status: 400 });

  const supabase = getSupabase();
  const log = (...a: unknown[]) => console.log('[localize-bg]', `job#${jobId}`, ...a);

  const { data: claimed } = await supabase
    .from('video_build_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (!claimed) { log('not pending — skipping'); return new Response('skip', { status: 200 }); }

  const scenes: string[] = (Array.isArray(claimed.scenes) ? claimed.scenes : [])
    .map((s: { text?: string }) => (s && typeof s.text === 'string' ? s.text.trim() : ''))
    .filter(Boolean);
  const voice = claimed.voice || 'alloy';
  const language = (claimed as { language?: string | null }).language || null;
  const sourcePath = (claimed as { source_path?: string | null }).source_path || '';

  const workDir = makeWorkDir('wloc-');
  try {
    if (!sourcePath) throw new Error('no source video on the job');
    if (scenes.length === 0) throw new Error('no lines to voice');

    // 1. Voiceover: one clip per line, so subtitles can be timed to each line.
    const sceneAudios: string[] = [];
    const durs: number[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const mp3 = path.join(workDir, `vo_${i}.mp3`);
      await ttsScene(scenes[i], voice, mp3);
      durs.push(Math.max(0.8, await probeDuration(mp3)));
      sceneAudios.push(mp3);
    }
    const total = durs.reduce((a, b) => a + b, 0);

    const aList = path.join(workDir, 'a_list.txt');
    fs.writeFileSync(aList, sceneAudios.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    const voiceFile = path.join(workDir, 'voice.mp3');
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', aList, '-c', 'copy', voiceFile]);

    // 2. Original footage, normalized to the vertical target, fitted to the
    // voiceover length: looped if shorter, trimmed if longer.
    const raw = path.join(workDir, 'raw.mp4');
    await downloadSource(supabase, sourcePath, raw);
    const norm = path.join(workDir, 'norm.mp4');
    await normalizeShot(raw, norm);
    const srcDur = await probeDuration(norm);
    const visual = path.join(workDir, 'visual.mp4');
    if (srcDur >= total - 0.05) {
      await run(FFMPEG, ['-y', '-i', norm, '-t', total.toFixed(2), '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', visual]);
    } else {
      await run(FFMPEG, ['-y', '-stream_loop', '-1', '-i', norm, '-t', total.toFixed(2), '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', visual]);
    }
    log(`source ${srcDur.toFixed(1)}s ${srcDur >= total ? 'trimmed' : 'looped'} to ${total.toFixed(1)}s`);

    // 3. Mux voiceover onto the footage.
    const base = path.join(workDir, 'base.mp4');
    await run(FFMPEG, ['-y', '-i', visual, '-i', voiceFile,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', base]);

    // 4. Subtitles: one cue per line, timed to its voiceover clip.
    const cues: { start: number; end: number; text: string }[] = [];
    let t = 0;
    for (let i = 0; i < scenes.length; i++) {
      cues.push({ start: t, end: t + durs[i], text: scenes[i] });
      t += durs[i];
    }
    fs.writeFileSync(path.join(workDir, 'subs.ass'), buildAss(cues));

    let fontArg = '';
    const fontSrc = findCaptionFont();
    if (fontSrc) {
      const fontDir = path.join(workDir, 'fonts');
      fs.mkdirSync(fontDir, { recursive: true });
      fs.copyFileSync(fontSrc, path.join(fontDir, 'caption.ttf'));
      fontArg = ':fontsdir=fonts';
    } else {
      log('WARNING: caption font not found — subtitles may not render');
    }
    const finalFile = path.join(workDir, 'final.mp4');
    try {
      await run(FFMPEG, ['-y', '-i', base, '-vf', `ass=subs.ass${fontArg}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'copy', finalFile],
        { cwd: workDir });
    } catch (e) {
      log(`subtitle burn failed, using base: ${(e as Error).message}`);
      fs.copyFileSync(base, finalFile);
    }

    const thumb = path.join(workDir, 'thumb.jpg');
    try { await grabThumb(finalFile, 1, thumb); } catch { /* ignore */ }

    const stamp = Date.now();
    const clipKey = `${projectId}/generated/${adId}_loc_${stamp}.mp4`;
    const thumbKey = `${projectId}/generated/${adId}_loc_${stamp}.jpg`;
    await uploadFile(supabase, clipKey, finalFile, 'video/mp4');
    let storedThumb = '';
    try { storedThumb = await uploadFile(supabase, thumbKey, thumb, 'image/jpeg'); } catch { /* ignore */ }
    const totalDur = await probeDuration(finalFile);

    const gvRow: Record<string, unknown> = {
      project_id: projectId, brand_id: brandId, ad_id: adId,
      file_path: clipKey, thumb_path: storedThumb || null,
      duration_sec: +totalDur.toFixed(2),
      script: scenes.join('\n'), voice, language,
    };
    let gvRes = await supabase.from('generated_videos').insert(gvRow).select('id').maybeSingle();
    if (gvRes.error && /language/i.test(gvRes.error.message)) {
      delete gvRow.language;
      gvRes = await supabase.from('generated_videos').insert(gvRow).select('id').maybeSingle();
    }

    await supabase
      .from('video_build_jobs')
      .update({ status: 'done', result_id: gvRes.data?.id || null, finished_at: new Date().toISOString() })
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
