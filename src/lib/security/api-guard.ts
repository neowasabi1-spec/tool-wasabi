/**
 * Unified API route protection wrapper.
 * Combines authentication, rate limiting, input validation, audit logging,
 * and error sanitization in a single composable guard.
 *
 * Per SOC 2: Security (auth, rate limiting), Processing Integrity (validation),
 * Confidentiality (error sanitization), Availability (rate limiting).
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiLimiter, aiLimiter, getClientIp } from './rate-limiter';
import { audit } from './audit-logger';

export interface GuardOptions {
  /** Require a valid API key via X-API-Key header or Supabase auth token */
  requireAuth?: boolean;
  /** Which rate limiter to use: 'api' (60/min) or 'ai' (15/min) */
  rateLimit?: 'api' | 'ai' | 'none';
  /** Maximum allowed request body size in bytes (default: 1MB) */
  maxBodySize?: number;
  /** Allowed HTTP methods */
  allowedMethods?: string[];
}

const DEFAULT_OPTIONS: GuardOptions = {
  requireAuth: false,
  rateLimit: 'api',
  maxBodySize: 1_048_576,
};

export type RouteHandler = (
  request: NextRequest,
  context: { ip: string; userId?: string }
) => Promise<NextResponse>;

function sanitizeErrorMessage(error: unknown): string {
  if (process.env.NODE_ENV === 'development') {
    return error instanceof Error ? error.message : 'Unknown error';
  }
  return 'An internal error occurred. Please try again later.';
}

export function withGuard(handler: RouteHandler, opts?: GuardOptions) {
  const options = { ...DEFAULT_OPTIONS, ...opts };

  return async (request: NextRequest): Promise<NextResponse> => {
    const ip = getClientIp(request);
    const method = request.method;

    // 1. Method check
    if (options.allowedMethods && !options.allowedMethods.includes(method)) {
      return NextResponse.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: options.allowedMethods.join(', ') } }
      );
    }

    // 2. Rate limiting
    if (options.rateLimit !== 'none') {
      const limiter = options.rateLimit === 'ai' ? aiLimiter : apiLimiter;
      const result = limiter.check(ip);

      if (!result.allowed) {
        await audit.warn('API_RATE_LIMITED', `Rate limited: ${request.nextUrl.pathname}`, {
          actor_ip: ip,
          details: { path: request.nextUrl.pathname, retryAfterMs: result.retryAfterMs },
        });

        return NextResponse.json(
          { error: 'Too many requests. Please try again later.' },
          {
            status: 429,
            headers: {
              'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)),
              'X-RateLimit-Remaining': '0',
            },
          }
        );
      }
    }

    // 3. Authentication
    let userId: string | undefined;

    if (options.requireAuth) {
      const apiKey = request.headers.get('x-api-key');
      const authHeader = request.headers.get('authorization');
      const dashboardSecret = process.env.DASHBOARD_API_SECRET;

      // Option A: Dashboard API secret (for internal/server-to-server calls)
      if (dashboardSecret && apiKey === dashboardSecret) {
        userId = 'system';
      }
      // Option B: Supabase JWT token
      else if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        try {
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
          const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
          if (supabaseUrl && serviceKey) {
            const { createClient } = await import('@supabase/supabase-js');
            const adminClient = createClient(supabaseUrl, serviceKey);
            const { data, error } = await adminClient.auth.getUser(token);
            if (!error && data.user) {
              userId = data.user.id;
            }
          }
        } catch {
          // fall through to unauthorized
        }
      }

      if (!userId) {
        await audit.warn('API_UNAUTHORIZED', `Unauthorized: ${request.nextUrl.pathname}`, {
          actor_ip: ip,
          details: { path: request.nextUrl.pathname },
        });

        return NextResponse.json(
          { error: 'Authentication required' },
          { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
        );
      }
    }

    // 4. Body size check (for POST/PUT/PATCH)
    if (['POST', 'PUT', 'PATCH'].includes(method) && options.maxBodySize) {
      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > options.maxBodySize) {
        return NextResponse.json(
          { error: 'Request body too large' },
          { status: 413 }
        );
      }
    }

    // 5. Execute handler with error boundary
    try {
      const response = await handler(request, { ip, userId });

      // Add security headers to every response
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('X-Frame-Options', 'DENY');

      return response;
    } catch (error) {
      await audit.error('SECURITY_VIOLATION', `Unhandled error: ${request.nextUrl.pathname}`, {
        actor_ip: ip,
        actor_id: userId,
        details: {
          path: request.nextUrl.pathname,
          error: error instanceof Error ? error.message : 'Unknown',
        },
      });

      return NextResponse.json(
        { error: sanitizeErrorMessage(error) },
        { status: 500 }
      );
    }
  };
}
