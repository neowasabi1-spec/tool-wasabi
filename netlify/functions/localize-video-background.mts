import fs from 'fs';
import path from 'path';
import {
  getSupabase, run, FFMPEG, makeWorkDir, probeDuration, ttsScene,
  keepSourceFrame, downloadSource, grabThumb, uploadFile,
} from './_shared/video';
import {
  applyFixes, buildCoverAss, checkCover, coverFontsDir, hasVision, planCover,
  type CaptionCue, type CoverIssue, type Reading,
} from './_shared/caption-cover';

/**
 * Background function that LOCALIZES an existing creative video: it keeps the
 * cleaned footage (or original if none), replaces the audio with a voiceover
 * from the job's copy, and burns matching subtitles. No shot pool — the
 * visual is the source video itself. The new voice is sped up or slowed
 * so it lasts as long as that footage. Original audio is dropped.
 *
 * Triggered by the ads/[adId]/build-video route with mode 'localize'.
 * Body: { jobId, projectId, brandId, adId }
 */

const COVER_BUDGET_MS = 10 * 60 * 1000;

function spokenOnly(raw: string): string {
  let s = String(raw || '').replace(/\r/g, '');
  const block = /SCRIPT\s*:\s*([\s\S]*?)(?=\b(?:ON-SCREEN|CTA)\b|$)/i.exec(s);
  if (block) s = block[1];
  return s
    .replace(/\b(?:HOOK|SCRIPT|CTA)\s*:\s*/gi, '')
    .replace(/\bON-SCREEN(?:\s*\/\s*B-ROLL)?\s*:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ffmpeg atempo is only valid in 0.5–2. Chain filters to reach the real speed. */
function atempoChain(speed: number): string {
  const parts: string[] = [];
  let r = Math.min(4, Math.max(0.5, speed));
  while (r > 2) { parts.push('atempo=2.0'); r /= 2; }
  while (r < 0.5) { parts.push('atempo=0.5'); r /= 0.5; }
  parts.push(`atempo=${r.toFixed(3)}`);
  return parts.join(',');
}

/** 3–5 word bites so captions flip with the voice instead of sitting as a wall. */
function captionChunks(text: string, wordsPer = 4): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    let n = Math.min(wordsPer, words.length - i);
    const left = words.length - i - n;
    if (left > 0 && left <= 2) n += left;
    const slice = words.slice(i, i + n);
    let cut = slice.length;
    for (let k = 1; k < slice.length - 1; k++) {
      if (/[,;:…—–]$/.test(slice[k])) { cut = k + 1; break; }
    }
    chunks.push(slice.slice(0, cut).join(' '));
    i += cut;
  }
  return chunks;
}

function cuesForScene(
  text: string, start: number, dur: number,
): { start: number; end: number; text: string }[] {
  const parts = captionChunks(text);
  if (parts.length <= 1) return [{ start, end: start + dur, text: parts[0] || text }];
  const weights = parts.map((p) => Math.max(4, p.replace(/\s/g, '').length));
  const sum = weights.reduce((a, b) => a + b, 0);
  const cues: { start: number; end: number; text: string }[] = [];
  let t = start;
  for (let i = 0; i < parts.length; i++) {
    const len = i === parts.length - 1 ? start + dur - t : dur * (weights[i] / sum);
    cues.push({ start: t, end: t + len, text: parts[i] });
    t += len;
  }
  return cues;
}

export default async (req: Request) => {
  let body: { jobId?: number; projectId?: string; brandId?: number; adId?: number };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const { jobId, projectId } = body;
  const brandId = body.brandId || 0;
  const adId = body.adId || 0;
  if (!jobId || !projectId) return new Response('missing fields', { status: 400 });

  const supabase = getSupabase();
  const startedAt = Date.now();
  const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
  const trail: string[] = [];
  const log = (...a: unknown[]) => {
    trail.push([elapsed(), ...a.map(String)].join(' '));
    console.log('[localize-bg]', `job#${jobId}`, elapsed(), ...a);
  };

  const { data: claimed } = await supabase
    .from('video_build_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (!claimed) { log('not pending — skipping'); return new Response('skip', { status: 200 }); }

  const scenes: string[] = (Array.isArray(claimed.scenes) ? claimed.scenes : [])
    .map((s: { text?: string }) => (s && typeof s.text === 'string' ? spokenOnly(s.text) : ''))
    .filter((s) => s.length > 2);
  const voice = claimed.voice || 'alloy';
  const language = (claimed as { language?: string | null }).language || null;
  const sourcePath = (claimed as { source_path?: string | null }).source_path || '';

  const workDir = makeWorkDir('wloc-');
  try {
    if (!sourcePath) throw new Error('no source video on the job');
    if (scenes.length === 0) throw new Error('no lines to voice');

    // 1. Voiceover: one clip per line, so subtitles can be timed to each line.
    const sceneAudios: string[] = [];
    let durs: number[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const mp3 = path.join(workDir, `vo_${i}.mp3`);
      await ttsScene(scenes[i], voice, mp3);
      durs.push(Math.max(0.8, await probeDuration(mp3)));
      sceneAudios.push(mp3);
    }
    const spoken = durs.reduce((a, b) => a + b, 0);

    const aList = path.join(workDir, 'a_list.txt');
    fs.writeFileSync(aList, sceneAudios.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    const voiceRaw = path.join(workDir, 'voice-raw.mp3');
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', aList, '-c', 'copy', voiceRaw]);

    // 2. Picture only: drop the original soundtrack. Keep the source length.
    const raw = path.join(workDir, 'raw.mp4');
    await downloadSource(supabase, sourcePath, raw);
    const norm = path.join(workDir, 'norm.mp4');
    const { w: frameW, h: frameH } = await keepSourceFrame(raw, norm);
    const srcDur = await probeDuration(norm);
    const visual = path.join(workDir, 'visual.mp4');
    await run(FFMPEG, ['-y', '-i', norm, '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', visual]);

    // Speed the voice so it lasts as long as the footage (0.5×–2×, chained if needed).
    const speed = Math.min(2, Math.max(0.5, spoken / Math.max(0.8, srcDur)));
    const voiceFile = path.join(workDir, 'voice.mp3');
    if (Math.abs(speed - 1) > 0.03) {
      await run(FFMPEG, ['-y', '-i', voiceRaw, '-filter:a', atempoChain(speed), voiceFile]);
      durs = durs.map((d) => d / speed);
    } else {
      fs.copyFileSync(voiceRaw, voiceFile);
    }
    log(`source ${srcDur.toFixed(1)}s ${frameW}x${frameH}, voice ${spoken.toFixed(1)}s at ${speed.toFixed(2)}x`);

    // 3. Mux voiceover onto the footage.
    const base = path.join(workDir, 'base.mp4');
    await run(FFMPEG, ['-y', '-i', visual, '-i', voiceFile,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', srcDur.toFixed(2),
      // faststart so the browser can stream it; otherwise the moov atom lands at
      // the end and the player only shows the first second over a range request.
      '-movflags', '+faststart', base]);

    // 4. Subtitles: short 3–5 word bites timed inside each spoken line, so
    // they flip with the voice instead of sitting as a wall of text.
    const cues: CaptionCue[] = [];
    let t = 0;
    for (let i = 0; i < scenes.length; i++) {
      cues.push(...cuesForScene(scenes[i], t, durs[i]));
      t += durs[i];
    }
    log(`captions: ${cues.length} cues from ${scenes.length} spoken line(s)`);
    const labeled = cues.map((c) => c.text).filter((t) => /\b(hook|script|cta|on-screen)\b/i.test(t));
    if (!cues.length || labeled.length) {
      throw new Error(labeled.length
        ? `Captions still say “${labeled[0]}”. Video was not published.`
        : 'No captions to burn. Video was not published.');
    }
    // 5. Cover the burned-in captions: each phrase's lines are read by the
    // vision model and measured in the pixels, the new line goes on plates
    // of that size, then every phrase is checked frame by frame and widened
    // where old letters still show.
    if (!hasVision()) throw new Error('No vision model key is set, so the original captions cannot be checked. Video was not published.');
    const plan = await planCover(visual, srcDur, frameW, frameH, workDir, log);
    if (!plan.blocks.length) throw new Error('No burned-in caption was found, so the video was not published.');
    const fonts = coverFontsDir(workDir);
    if (!fonts) throw new Error('Caption fonts are missing from the function bundle. Video was not published.');
    const finalFile = path.join(workDir, 'final.mp4');
    const readings = new Map<string, Reading | null>();
    let blocks = plan.blocks;
    let issues: CoverIssue[] = [];
    for (let round = 0; round < 3; round++) {
      // Background functions are killed at 15 min, which would leave the job
      // stuck in processing; stop early with an error instead.
      if (round > 0 && Date.now() - startedAt > COVER_BUDGET_MS) {
        throw new Error(`Ran out of time checking the captions (${elapsed()}), old subtitles still show. Video was not published.`);
      }
      const built = buildCoverAss(cues, blocks, frameW, frameH, srcDur);
      blocks = built.blocks;
      fs.writeFileSync(path.join(workDir, 'subs.ass'), built.ass);
      try {
        await run(FFMPEG, ['-y', '-i', base, '-vf', `ass=subs.ass:fontsdir=${fonts}`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'copy',
          '-movflags', '+faststart', finalFile],
          { cwd: workDir });
      } catch (e) {
        throw new Error(`Subtitles were not burned, so the video was not published. ${(e as Error).message}`);
      }
      log(`burned round ${round}`);
      issues = await checkCover(base, finalFile, blocks, built.plates, cues, plan.hints, frameW, frameH, workDir, readings, log);
      log(`cover check round ${round}: ${issues.length} issue(s)`);
      if (!issues.length) break;
      blocks = applyFixes(blocks, issues, frameW, frameH);
    }
    if (issues.length) {
      // Keep the rejected render and what the check saw, so the failure can be looked at.
      try {
        const report = path.join(workDir, 'rejected.json');
        fs.writeFileSync(report, JSON.stringify({ issues, blocks, hints: plan.hints, cues, trail }, null, 1));
        await uploadFile(supabase, `${projectId}/generated/rejected/${jobId}.json`, report, 'application/json');
        await uploadFile(supabase, `${projectId}/generated/rejected/${jobId}.mp4`, finalFile, 'video/mp4');
      } catch { /* the error below matters more */ }
      const at = [...new Set(issues.map((x) => x.t.toFixed(1)))].slice(0, 5).join('s, ');
      throw new Error(`Original subtitles still show at ${at}s. Video was not published.`);
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
