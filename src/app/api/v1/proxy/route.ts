import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@/lib/api-key-auth';

/**
 * Universal proxy: lets full_access API keys call ANY internal API route.
 * 
 * Usage:
 *   POST /api/v1/proxy
 *   Headers: X-API-Key: fsk_...
 *   Body: {
 *     "method": "GET" | "POST" | "PUT" | "DELETE",
 *     "path": "/api/funnel-brief/chat",
 *     "body": { ... }       // optional, for POST/PUT
 *     "params": { ... }     // optional, added as query string for GET
 *   }
 * 
 * This gives external tools (OpenClaw, etc.) full access to every
 * internal endpoint: AI analysis, cloning, swipe pipeline, deploy, etc.
 */
export async function POST(req: NextRequest) {
  const auth = await validateApiKey(req, 'full_access');
  if (!auth.valid) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let payload: {
    method?: string;
    path?: string;
    body?: unknown;
    params?: Record<string, string>;
  };

  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { method = 'GET', path, body, params } = payload;

  if (!path || !path.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Missing or invalid "path". Must start with /api/' },
      { status: 400 }
    );
  }

  // Prevent recursive proxy calls
  if (path.startsWith('/api/v1/proxy')) {
    return NextResponse.json({ error: 'Cannot proxy to self' }, { status: 400 });
  }

  // Prevent access to API key management via proxy
  if (path.startsWith('/api/api-keys')) {
    return NextResponse.json({ error: 'API key management not available via proxy' }, { status: 403 });
  }

  const upperMethod = method.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upperMethod)) {
    return NextResponse.json({ error: `Invalid method: ${method}` }, { status: 400 });
  }

  // Build target URL
  const origin = req.nextUrl.origin;
  const targetUrl = new URL(path, origin);

  if (params && upperMethod === 'GET') {
    for (const [k, v] of Object.entries(params)) {
      targetUrl.searchParams.set(k, v);
    }
  }

  try {
    const fetchOptions: RequestInit = {
      method: upperMethod,
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-From': `api-key:${auth.apiKey.name}`,
      },
    };

    if (body && ['POST', 'PUT', 'PATCH'].includes(upperMethod)) {
      fetchOptions.body = JSON.stringify(body);
    }

    const res = await fetch(targetUrl.toString(), fetchOptions);

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const data = await res.json();
      return NextResponse.json(
        { status: res.status, data, proxied_path: path, api_key: auth.apiKey.name },
        { status: res.status }
      );
    }

    // Non-JSON response (HTML, text, etc.)
    const text = await res.text();
    return NextResponse.json(
      { status: res.status, data: text, content_type: contentType, proxied_path: path },
      { status: res.status }
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Proxy error: ${(err as Error).message}`, proxied_path: path },
      { status: 502 }
    );
  }
}

// GET endpoint to list all available internal routes
export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req, 'full_access');
  if (!auth.valid) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  return NextResponse.json({
    message: 'Full Access Proxy - POST to this endpoint to call any internal API route',
    usage: {
      method: 'POST',
      headers: { 'X-API-Key': 'fsk_your_key', 'Content-Type': 'application/json' },
      body: {
        method: 'GET | POST | PUT | DELETE',
        path: '/api/...',
        body: '(optional) request body for POST/PUT',
        params: '(optional) query params for GET',
      },
    },
    available_routes: [
      { method: 'GET/POST', path: '/api/v1/products', description: 'Products CRUD' },
      { method: 'GET/POST', path: '/api/v1/funnels', description: 'Funnel pages CRUD' },
      { method: 'GET/POST', path: '/api/v1/templates', description: 'Swipe templates CRUD' },
      { method: 'GET/POST', path: '/api/v1/archive', description: 'Archived funnels CRUD' },
      { method: 'POST', path: '/api/v1/chat', description: 'AI chat' },
      { method: 'POST', path: '/api/funnel-brief/chat', description: 'Funnel brief AI chat' },
      { method: 'POST', path: '/api/funnel-brief/analyze', description: 'Funnel brief analysis' },
      { method: 'POST', path: '/api/analyze-copy', description: 'Copy analysis' },
      { method: 'POST', path: '/api/funnel/analyze', description: 'Funnel AI analysis' },
      { method: 'POST', path: '/api/landing/clone', description: 'Clone a landing page' },
      { method: 'POST', path: '/api/landing/swipe', description: 'Swipe a landing page' },
      { method: 'POST', path: '/api/clone-funnel', description: 'Clone entire funnel' },
      { method: 'POST', path: '/api/product-brief', description: 'Generate product brief' },
      { method: 'POST', path: '/api/generate-quiz', description: 'Generate quiz funnel' },
      { method: 'POST', path: '/api/ai-edit-html', description: 'AI edit HTML' },
      { method: 'POST', path: '/api/ai-edit-element', description: 'AI edit element' },
      { method: 'POST', path: '/api/rewrite-section', description: 'Rewrite section' },
      { method: 'POST', path: '/api/generate-image', description: 'Generate image' },
      { method: 'GET/POST', path: '/api/prompts', description: 'Saved prompts' },
      { method: 'POST', path: '/api/deploy/funnelish', description: 'Deploy to Funnelish' },
      { method: 'POST', path: '/api/deploy/checkout-champ', description: 'Deploy to CheckoutChamp' },
      { method: 'POST', path: '/api/reverse-funnel/analyze', description: 'Reverse funnel analysis' },
      { method: 'POST', path: '/api/compliance-ai/check', description: 'Compliance check' },
      { method: 'GET', path: '/api/health', description: 'Health check' },
    ],
  });
}
