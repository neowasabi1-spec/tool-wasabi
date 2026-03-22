import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';

export async function POST(req: NextRequest) {
  const auth = await validateApiKey(req, 'ai_chat');
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json();

  // Proxy to the internal funnel-brief/chat route
  const internalUrl = new URL('/api/funnel-brief/chat', req.url);
  const res = await fetch(internalUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
