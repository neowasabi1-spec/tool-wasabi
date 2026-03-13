/**
 * Next.js Edge Middleware — first line of defense.
 *
 * SOC 2 Security controls implemented:
 * - Security headers on every response (CSP, HSTS, X-Frame-Options, etc.)
 * - Authentication gate for dashboard pages
 * - CORS enforcement for API routes
 * - Request ID injection for traceability
 */

import { NextResponse, type NextRequest } from 'next/server';

// Pages that can be accessed without authentication
const PUBLIC_PATHS = new Set(['/login', '/auth/callback', '/auth/signup']);
const PUBLIC_API = new Set(['/api/health']);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (PUBLIC_API.has(pathname)) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname.startsWith('/favicon')) return true;
  if (pathname.match(/\.(ico|png|jpg|jpeg|svg|gif|webp|css|js|woff2?)$/)) return true;
  return false;
}

function addSecurityHeaders(response: NextResponse): void {
  // Strict Transport Security — force HTTPS for 1 year + include subdomains
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload'
  );

  // Prevent MIME sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY');

  // XSS protection (legacy browsers)
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Referrer policy — don't leak full URL to third parties
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy — restrict sensitive browser features
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  );

  // Content Security Policy — tight defaults with necessary relaxations
  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "frame-src 'self' https:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.anthropic.com https://generativelanguage.googleapis.com https://api.openai.com https://api.firecrawl.dev",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  // Request tracing
  response.headers.set(
    'X-Request-Id',
    crypto.randomUUID()
  );
}

function handleCors(request: NextRequest, response: NextResponse): NextResponse {
  const origin = request.headers.get('origin') || '';
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

  // In development allow localhost
  if (process.env.NODE_ENV === 'development') {
    allowedOrigins.push('http://localhost:3000', 'http://localhost:3001');
  }

  if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin || '*');
  }

  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Request-Id');
  response.headers.set('Access-Control-Max-Age', '86400');
  response.headers.set('Access-Control-Allow-Credentials', 'true');

  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 });
    addSecurityHeaders(response);
    handleCors(request, response);
    return response;
  }

  // Public paths — no auth required
  if (isPublicPath(pathname)) {
    const response = NextResponse.next();
    addSecurityHeaders(response);
    if (pathname.startsWith('/api/')) handleCors(request, response);
    return response;
  }

  // Authentication gate
  // When DASHBOARD_API_SECRET is set, enforce auth for non-public paths.
  // This uses Supabase session cookies or Bearer tokens.
  const dashboardSecret = process.env.DASHBOARD_API_SECRET;

  if (dashboardSecret) {
    const isApiRoute = pathname.startsWith('/api/');

    if (isApiRoute) {
      // API routes: check X-API-Key header or Authorization Bearer token
      const apiKey = request.headers.get('x-api-key');
      const authHeader = request.headers.get('authorization');

      const hasValidKey = apiKey === dashboardSecret;
      const hasToken = authHeader?.startsWith('Bearer ');

      if (!hasValidKey && !hasToken) {
        const response = NextResponse.json(
          { error: 'Authentication required' },
          { status: 401 }
        );
        addSecurityHeaders(response);
        handleCors(request, response);
        return response;
      }
    } else {
      // Page routes: check for Supabase auth cookie
      const supabaseCookie = request.cookies.getAll().find(
        (c) => c.name.startsWith('sb-') && c.name.endsWith('-auth-token')
      );

      if (!supabaseCookie) {
        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('redirect', pathname);
        const response = NextResponse.redirect(loginUrl);
        addSecurityHeaders(response);
        return response;
      }
    }
  }

  const response = NextResponse.next();
  addSecurityHeaders(response);
  if (pathname.startsWith('/api/')) handleCors(request, response);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
