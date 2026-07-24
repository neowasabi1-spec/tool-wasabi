/**
 * Speech-to-text transcription for saved video creatives.
 *
 * Prefers OpenAI Whisper (purpose-built, accepts mp4/webm directly, up to
 * 25MB). Falls back to Gemini multimodal (inline video) when no OpenAI key is
 * present. Never throws — returns '' on any failure so callers can degrade
 * gracefully (the creative is still saved, just without a transcript).
 */

const WHISPER_MAX_BYTES = 24 * 1024 * 1024; // OpenAI hard limit is 25MB
const GEMINI_INLINE_MAX_BYTES = 18 * 1024 * 1024; // inline request payload cap

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('transcribe timeout')), ms)),
  ]);
}

async function transcribeWithWhisper(buffer: Buffer, contentType: string): Promise<string> {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) return '';
  if (buffer.length > WHISPER_MAX_BYTES) return '';
  try {
    const fd = new FormData();
    const ext = /webm/i.test(contentType) ? 'webm' : /quicktime|mov/i.test(contentType) ? 'mov' : 'mp4';
    fd.append('file', new Blob([buffer], { type: contentType || 'video/mp4' }), `clip.${ext}`);
    fd.append('model', 'whisper-1');
    fd.append('response_format', 'text');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
    if (!res.ok) return '';
    const text = await res.text();
    return (text || '').trim();
  } catch {
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
                text: 'Transcribe the spoken audio in this video verbatim. Return ONLY the transcript text, no timestamps, no commentary. If there is no speech, return an empty string.',
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

/**
 * Transcribe a video's audio track. `contentType` should be the media MIME
 * type (e.g. video/mp4). Returns the transcript, or '' when unavailable.
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
