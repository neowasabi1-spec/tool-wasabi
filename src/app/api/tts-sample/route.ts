import { NextRequest, NextResponse } from 'next/server';

/**
 * Voice preview for the "Recreate video" voiceover picker.
 *
 * GET /api/tts-sample?voice=nova
 *   → short OpenAI TTS clip (audio/mpeg) so the user can hear a voice before
 *     committing to a full build. The sample text is fixed per voice, so the
 *     response is safely cacheable (immutable) — repeated previews don't re-bill.
 */

export const runtime = 'nodejs';

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
const SAMPLE_TEXT =
  "Hey — this is how your video voiceover will sound. Clean, natural, and ready to convert.";

export async function GET(req: NextRequest) {
  const voice = (req.nextUrl.searchParams.get('voice') || 'alloy').toLowerCase();
  if (!VOICES.includes(voice as (typeof VOICES)[number])) {
    return NextResponse.json({ error: 'Unknown voice' }, { status: 400 });
  }

  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) {
    return NextResponse.json(
      { error: 'Voice preview needs an OpenAI API key configured on the server.' },
      { status: 503 },
    );
  }

  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice,
        input: SAMPLE_TEXT,
        response_format: 'mp3',
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return NextResponse.json(
        { error: `OpenAI TTS failed (${res.status})`, detail: detail.slice(0, 300) },
        { status: 502 },
      );
    }

    const audio = Buffer.from(await res.arrayBuffer());
    return new NextResponse(audio, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audio.length),
        // Sample text is fixed per voice → cache hard so we never re-bill.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Voice preview failed' },
      { status: 500 },
    );
  }
}
