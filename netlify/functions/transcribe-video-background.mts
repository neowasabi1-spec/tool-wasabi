import fs from 'fs';
import path from 'path';
import { FFMPEG, downloadSource, getSupabase, makeWorkDir, run } from './_shared/video';

/**
 * Background function (up to 15 min). The Next route cannot ship ffmpeg, so
 * Whisper was handed the raw mp4 and returned nothing — the manual Extract
 * button always errored. Voiceover is transcribed from the audio track, so a
 * clip with no burned-in subtitles still yields the spoken copy.
 *
 * Body: { projectId, brandId, adId }
 */
export default async (req: Request) => {
  let body: { projectId?: string; brandId?: number; adId?: number };
  try {
    body = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const { projectId, brandId, adId } = body;
  if (!projectId || !brandId || !adId) return new Response('missing fields', { status: 400 });

  const supabase = getSupabase();
  const log = (...a: unknown[]) => console.log('[transcribe-bg]', `ad#${adId}`, ...a);

  const mark = async (patch: Record<string, unknown>) => {
    let { error } = await supabase.from('competitor_ads').update(patch).eq('id', adId).eq('project_id', projectId);
    if (error && /transcript_status|transcript_error|schema cache|42703|PGRST204/i.test(error.message || '')) {
      const spoken = patch.transcript;
      if (typeof spoken === 'string' && spoken) {
        ({ error } = await supabase.from('competitor_ads').update({ transcript: spoken }).eq('id', adId).eq('project_id', projectId));
      }
    }
    if (error) log('save failed:', error.message);
  };

  const workDir = makeWorkDir('wtx-');
  try {
    const { data: ad, error: adErr } = await supabase
      .from('competitor_ads')
      .select('id, file_path, media_type')
      .eq('id', adId)
      .eq('project_id', projectId)
      .eq('brand_id', brandId)
      .maybeSingle();
    if (adErr) throw new Error(adErr.message);
    if (!ad) throw new Error('Creative not found');
    if (ad.media_type !== 'video') throw new Error('Only videos can be transcribed');
    if (!ad.file_path) throw new Error('No video file stored');

    const src = path.join(workDir, 'in.mp4');
    await downloadSource(supabase, ad.file_path, src);
    log('downloaded', fs.statSync(src).size);

    const reasons: string[] = [];
    let spoken = '';
    const audio = path.join(workDir, 'audio.mp3');
    let audioBuf: Buffer | null = null;
    try {
      audioBuf = await extractVoice(src, audio);
      if (!audioBuf) reasons.push('no audio track');
    } catch (e) {
      reasons.push(e instanceof Error ? e.message : 'audio extract failed');
      log('audio:', reasons[reasons.length - 1]);
    }

    if (audioBuf) {
      spoken = usable(await whisper(audioBuf, reasons));
      if (!spoken) spoken = usable(await geminiMedia(audioBuf, 'audio/mpeg', SPEECH_PROMPT, reasons));
    }
    if (!spoken) {
      spoken = usable(await geminiMedia(fs.readFileSync(src), 'video/mp4', SPEECH_PROMPT, reasons));
    }

    if (!spoken) {
      const why = reasons.filter(Boolean).slice(-2).join(' · ') || 'No spoken voiceover found';
      log('empty:', why);
      await mark({ transcript_status: 'error', transcript_error: why.slice(0, 500) });
      return new Response(why, { status: 200 });
    }

    const text = spoken.slice(0, 8000);
    const fileKey = `${projectId}/competitor-transcripts/${adId}.txt`;
    const up = await supabase.storage.from('project-files').upload(fileKey, Buffer.from(text, 'utf8'), {
      contentType: 'text/plain; charset=utf-8',
      upsert: true,
    });
    if (up.error) log('file save:', up.error.message);
    else log('file saved', fileKey);

    await mark({
      transcript: text,
      transcript_status: 'ready',
      transcript_error: null,
    });
    log('saved', spoken.length, 'chars');
    return new Response('ok', { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Transcription failed';
    log('failed:', msg);
    await mark({ transcript_status: 'error', transcript_error: msg.slice(0, 500) });
    return new Response(msg, { status: 200 });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

/** Keep real speech. Drop only Whisper's music/silence labels. */
function usable(text: string): string {
  const s = text.trim();
  if (s.length < 3) return '';
  if (/^[\s.。…\-–—]*$/.test(s)) return '';
  if (/^(\[|\()?\s*(music|musica|silence|silenzio|blank|applause|inaudible)\s*(\]|\))?\.?$/i.test(s)) return '';
  return s;
}

/** Pull the voice track. No subtitles required — speech lives in the audio. */
async function extractVoice(src: string, out: string): Promise<Buffer | null> {
  const attempts = [
    ['-y', '-i', src, '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', out],
    ['-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', out],
  ];
  for (const args of attempts) {
    try {
      await run(FFMPEG, args);
      if (fs.existsSync(out) && fs.statSync(out).size > 800) return fs.readFileSync(out);
    } catch {
      /* try the next mapping */
    }
  }
  return null;
}

async function whisper(audio: Buffer, reasons: string[]): Promise<string> {
  const key = (process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '').trim();
  if (!key) {
    reasons.push('OPENAI_API_KEY missing');
    return '';
  }
  if (audio.length > 24 * 1024 * 1024) {
    reasons.push('audio larger than Whisper accepts');
    return '';
  }
  for (const model of ['whisper-1', 'gpt-4o-mini-transcribe']) {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'audio.mp3');
    fd.append('model', model);
    fd.append('response_format', 'text');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      reasons.push(`${model} ${res.status}: ${err.slice(0, 160)}`);
      continue;
    }
    const text = usable(await res.text());
    if (text) return text;
  }
  return '';
}

const SPEECH_PROMPT =
  'Transcribe the spoken voiceover verbatim, in the language being spoken. This clip often has NO subtitles: the words are only in the audio. Ignore background music. Return ONLY the words that are said, no timestamps, no commentary. If you hear speech, return it. Return an empty string only when there is no speech at all.';

async function geminiMedia(buf: Buffer, mime: string, prompt: string, reasons: string[]): Promise<string> {
  const key = (process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    reasons.push('GEMINI_API_KEY missing');
    return '';
  }
  try {
    const startRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buf.length),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'creative' } }),
    });
    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!startRes.ok || !uploadUrl) {
      const err = await startRes.text().catch(() => '');
      reasons.push(`Gemini upload ${startRes.status}: ${err.slice(0, 160)}`);
      return '';
    }
    const upRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(buf.length),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: new Uint8Array(buf),
    });
    if (!upRes.ok) {
      reasons.push(`Gemini upload ${upRes.status}`);
      return '';
    }
    const upJson = (await upRes.json()) as { file?: { uri?: string; name?: string; state?: string } };
    const fileUri = upJson.file?.uri || '';
    const fileName = upJson.file?.name || '';
    let fileState = upJson.file?.state || '';
    if (!fileUri || !fileName) {
      reasons.push('Gemini upload returned no file');
      return '';
    }
    const deadline = Date.now() + 180000;
    while (fileState === 'PROCESSING' || !fileState) {
      if (Date.now() > deadline) {
        reasons.push('Gemini file processing timed out');
        return '';
      }
      await new Promise((r) => setTimeout(r, 2000));
      const st = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${key}`);
      if (!st.ok) {
        reasons.push(`Gemini file status ${st.status}`);
        return '';
      }
      const stJson = (await st.json()) as { state?: string };
      fileState = stJson.state || '';
      if (fileState === 'FAILED') {
        reasons.push('Gemini could not process the video');
        return '';
      }
    }
    const genRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, { file_data: { mime_type: mime, file_uri: fileUri } }] }],
          generationConfig: { temperature: 0 },
        }),
      },
    );
    fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${key}`, { method: 'DELETE' }).catch(() => {});
    if (!genRes.ok) {
      const err = await genRes.text().catch(() => '');
      reasons.push(`Gemini ${genRes.status}: ${err.slice(0, 160)}`);
      return '';
    }
    const data = (await genRes.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '').trim();
  } catch (e) {
    reasons.push(e instanceof Error ? e.message : 'Gemini failed');
    return '';
  }
}
