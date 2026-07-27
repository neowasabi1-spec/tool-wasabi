import fs from 'fs';
import path from 'path';
import {
  getSupabase, run, FFMPEG, makeWorkDir, probeDuration, ttsScene,
  buildSceneVisual, pickShotsForScene, loadCleanShots, srtTime, grabThumb, uploadFile,
} from './_shared/video';

/**
 * Background function (up to 15 min) that assembles a NEW video from the
 * project's CLEAN shots + an OpenAI TTS voiceover of the rewritten script +
 * our own burned-in subtitles. Triggered by the build-video enqueue route.
 *
 * Body: { jobId, projectId, brandId, adId }
 * The scenes + voice are read from the video_build_jobs row.
 */
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
    // Real-footage pool. Each clip is used at most ONCE (cursor never wraps);
    // when the pool runs out, buildSceneVisual fills the rest with AI b-roll.
    const pool = await loadCleanShots(supabase, projectId, workDir);
    log(`usable shots (clean + de-subbed): ${pool.length}`);

    const used = new Set<number>();
    const sceneVisuals: string[] = [];
    const sceneAudios: string[] = [];
    const srt: string[] = [];
    let t = 0;
    for (let i = 0; i < scenes.length; i++) {
      const mp3 = path.join(workDir, `vo_${i}.mp3`);
      await ttsScene(scenes[i], voice, mp3);
      const d = Math.max(0.8, await probeDuration(mp3));
      // Pick footage matching this scene's text (tags/caption), no reuse.
      const picked = pickShotsForScene(pool, used, scenes[i], d);
      const vis = await buildSceneVisual(picked.files, picked.dur, d, workDir, i, scenes[i]);
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
    const style =
      'FontSize=16,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,' +
      'BorderStyle=3,Outline=6,Shadow=0,Alignment=2,MarginV=90';
    try {
      await run(FFMPEG, [
        '-y', '-i', base, '-vf', `subtitles=subs.srt:force_style='${style}'`,
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
