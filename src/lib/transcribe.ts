/**
 * Speech-to-text transcription for saved video creatives.
 *
 * Prefers OpenAI Whisper on an extracted audio track (the video container
 * itself is often rejected). Falls back to Gemini, which also reads burned-in
 * captions when the clip has no usable speech. Never throws — returns '' on
 * any failure so callers can degrade gracefully.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';

const WHISPER_MAX_BYTES = 24 * 1024 * 1024; // OpenAI hard limit is 25MB
const GEMINI_INLINE_MAX_BYTES = 18 * 1024 * 1024; // inline request payload cap

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('transcribe timeout')), ms)),
  ]);
}

/** Whisper accepts audio reliably. Many ad mp4s are rejected as video files. */
async function audioForWhisper(video: Buffer): Promise<Buffer | null> {
  const bin = typeof ffmpegStatic === 'string' ? ffmpegStatic : '';
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  const src = path.join(dir, 'in.bin');
  const out = path.join(dir, 'audio.mp3');
  try {
    fs.writeFileSync(src, video);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(bin, ['-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', out], { stdio: 'ignore' });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
    });
    const audio = fs.readFileSync(out);
    return audio.length > 800 ? audio : null;
  } catch (e) {
    console.warn('[transcribe] audio extract:', e instanceof Error ? e.message : e);
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function transcribeWithWhisper(buffer: Buffer, contentType: string): Promise<string> {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) return '';
  let payload = buffer;
  let type = contentType || 'video/mp4';
  let name = /webm/i.test(type) ? 'clip.webm' : /quicktime|mov/i.test(type) ? 'clip.mov' : 'clip.mp4';
  if (/video/i.test(type) || payload.length > WHISPER_MAX_BYTES) {
    const audio = await audioForWhisper(buffer);
    if (audio) {
      payload = audio;
      type = 'audio/mpeg';
      name = 'audio.mp3';
    }
  }
  if (payload.length > WHISPER_MAX_BYTES) return '';
  try {
    const fd = new FormData();
    const bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    fd.append('file', new Blob([bytes], { type }), name);
    fd.append('model', 'whisper-1');
    fd.append('response_format', 'text');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn('[transcribe] whisper', res.status, err.slice(0, 300));
      return '';
    }
    const text = await res.text();
    return (text || '').trim();
  } catch (e) {
    console.warn('[transcribe] whisper:', e instanceof Error ? e.message : e);
    return '';
  }
}

async function transcribeWithGemini(buffer: Buffer, contentType: string): Promise<string> {
  const key = (process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
  if (!key) return '';
  if (buffer.length > GEMINI_INLINE_MAX_BYTES) return '';
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Transcribe this ad. Prefer the spoken words, verbatim. If speech is missing or there is only music, transcribe the burned-in on-screen captions in order instead. Return ONLY that text, no timestamps, no commentary. Return an empty string only when there is neither speech nor on-screen captions.',
              },
              { inline_data: { mime_type: contentType || 'video/mp4', data: buffer.toString('base64') } },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
    });
    if (!res.ok) return '';
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    return text.trim();
  } catch {
    return '';
  }
}

const TRANSCRIBE_PROMPT =
  'Transcribe this ad. Prefer the spoken words, verbatim. If speech is missing or there is only music, transcribe the burned-in on-screen captions in order instead. Return ONLY that text, no timestamps, no commentary. Return an empty string only when there is neither speech nor on-screen captions.';

function geminiKey(): string {
  return (process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
}

/**
 * Transcribe an arbitrarily large video via the Gemini File API: upload the
 * bytes, wait until the file is processed, then ask for a transcript. This is
 * the path for long VSL-style creatives that exceed the inline size caps.
 */
async function transcribeWithGeminiFileApi(
  buffer: Buffer,
  contentType: string,
  timeoutMs: number,
): Promise<string> {
  const key = geminiKey();
  if (!key) return '';
  const mime = contentType || 'video/mp4';
  const deadline = Date.now() + timeoutMs;
  try {
    // 1) Start a resumable upload session.
    const startRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(buffer.length),
          'X-Goog-Upload-Header-Content-Type': mime,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: 'creative' } }),
      },
    );
    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!startRes.ok || !uploadUrl) return '';

    // 2) Upload the bytes and finalize.
    const upRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(buffer.length),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: new Uint8Array(buffer),
    });
    if (!upRes.ok) return '';
    const upJson = (await upRes.json()) as { file?: { uri?: string; name?: string; state?: string } };
    const fileUri = upJson.file?.uri || '';
    const fileName = upJson.file?.name || '';
    let fileState = upJson.file?.state || '';
    if (!fileUri || !fileName) return '';

    // 3) Wait until the video finishes server-side processing (state ACTIVE).
    while (fileState === 'PROCESSING' || !fileState) {
      if (Date.now() > deadline) return '';
      await new Promise((r) => setTimeout(r, 2000));
      const st = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${key}`);
      if (!st.ok) return '';
      const stJson = (await st.json()) as { state?: string };
      fileState = stJson.state || '';
      if (fileState === 'FAILED') return '';
    }

    // 4) Ask for the transcript referencing the uploaded file.
    const genRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: TRANSCRIBE_PROMPT }, { file_data: { mime_type: mime, file_uri: fileUri } }] },
          ],
          generationConfig: { temperature: 0 },
        }),
      },
    );
    // Best-effort cleanup of the uploaded file.
    fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${key}`, { method: 'DELETE' }).catch(() => {});
    if (!genRes.ok) return '';
    const data = (await genRes.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '').trim();
  } catch {
    return '';
  }
}

/**
 * Transcribe a video's audio track. `contentType` should be the media MIME
 * type (e.g. video/mp4). Returns the transcript, or '' when unavailable.
 * Used by the automatic (short-clip) path — kept fast via inline APIs only.
 */
export async function transcribeVideo(
  buffer: Buffer | null,
  contentType: string,
  timeoutMs = 45000,
): Promise<string> {
  if (!buffer || buffer.length === 0) return '';
  try {
    const whisper = await withTimeout(transcribeWithWhisper(buffer, contentType), timeoutMs);
    if (whisper) return whisper;
    return await withTimeout(transcribeWithGemini(buffer, contentType), timeoutMs);
  } catch {
    return '';
  }
}

/**
 * On-demand transcription that also handles LONG videos: tries the fast inline
 * APIs first (Whisper / Gemini inline), then falls back to the Gemini File API
 * which accepts large files. Used by the manual "Extract text" button.
 */
export async function transcribeVideoAnySize(
  buffer: Buffer | null,
  contentType: string,
  timeoutMs = 240000,
): Promise<string> {
  if (!buffer || buffer.length === 0) return '';
  try {
    if (buffer.length <= WHISPER_MAX_BYTES) {
      const whisper = await withTimeout(transcribeWithWhisper(buffer, contentType), Math.min(timeoutMs, 120000));
      if (whisper) return whisper;
    }
    if (buffer.length <= GEMINI_INLINE_MAX_BYTES) {
      const inline = await withTimeout(transcribeWithGemini(buffer, contentType), Math.min(timeoutMs, 120000));
      if (inline) return inline;
    }
    return await transcribeWithGeminiFileApi(buffer, contentType, timeoutMs);
  } catch {
    return '';
  }
}
