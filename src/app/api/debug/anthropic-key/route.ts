import { NextResponse } from 'next/server';
import { getAnthropicKey } from '@/lib/anthropic-key';

export const dynamic = 'force-dynamic';

export async function GET() {
  const raw = process.env.ANTHROPIC_API_KEY || '';
  const normalized = getAnthropicKey();

  const info = {
    configured: !!raw,
    raw_length: raw.length,
    normalized_length: normalized.length,
    starts_with: normalized.substring(0, 12),
    ends_with: normalized.substring(Math.max(0, normalized.length - 6)),
    has_quotes: raw.startsWith('"') || raw.startsWith("'") || raw.endsWith('"') || raw.endsWith("'"),
    has_whitespace: raw !== raw.trim(),
    valid_format: normalized.startsWith('sk-ant-'),
    raw_first_char_code: raw.length > 0 ? raw.charCodeAt(0) : null,
    raw_last_char_code: raw.length > 0 ? raw.charCodeAt(raw.length - 1) : null,
  };

  if (!info.configured) {
    return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not set', ...info });
  }

  try {
    const testRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': normalized,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    const bodyText = await testRes.text();
    return NextResponse.json({
      ok: testRes.ok,
      status: testRes.status,
      statusText: testRes.statusText,
      body: bodyText.substring(0, 500),
      key_info: info,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      key_info: info,
    });
  }
}
