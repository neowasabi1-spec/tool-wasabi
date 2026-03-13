# Security Policy — SOC 2 Compliance

## Overview

This document describes the security controls implemented in the Funnel Swiper Dashboard aligned with the **SOC 2 Trust Services Criteria** (TSC) defined by AICPA:

1. **Security** (Common Criteria)
2. **Availability**
3. **Processing Integrity**
4. **Confidentiality**
5. **Privacy**

---

## 1. Security (Common Criteria)

### Authentication & Authorization

| Control | Implementation | File(s) |
|---------|---------------|---------|
| Authentication middleware | Next.js Edge Middleware intercepts all requests and validates Supabase Auth tokens or API keys | `src/middleware.ts` |
| Login page | Supabase Auth with email/password + passwordless magic link | `src/app/login/page.tsx` |
| API authentication | `withGuard()` wrapper validates Bearer tokens and X-API-Key headers | `src/lib/security/api-guard.ts` |
| Row-Level Security | Supabase RLS policies restrict data to `auth.uid()` owner | `supabase-migration-security.sql` |
| Service-role isolation | Server-side operations use `SUPABASE_SERVICE_ROLE_KEY` (never exposed to client) | `.env.local` |

### Network Security

| Control | Implementation |
|---------|---------------|
| HTTPS enforcement | HSTS header (`max-age=31536000; includeSubDomains; preload`) |
| CORS | Whitelist-based origin validation via `ALLOWED_ORIGINS` env var |
| CSP | Content-Security-Policy restricts script sources, frame ancestors, connect-src |
| Clickjacking prevention | `X-Frame-Options: DENY` + `frame-ancestors 'none'` in CSP |
| MIME sniffing prevention | `X-Content-Type-Options: nosniff` |

### Rate Limiting

| Tier | Window | Max Requests | Scope |
|------|--------|-------------|-------|
| General API | 1 min | 60 | Per IP |
| AI endpoints | 1 min | 15 | Per IP |
| Auth attempts | 15 min | 10 | Per IP |

Implementation: `src/lib/security/rate-limiter.ts`

### Security Headers

Applied at both middleware and `next.config.js` levels:

- `Strict-Transport-Security`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Content-Security-Policy` (strict)
- `X-Request-Id` (unique per request for traceability)

---

## 2. Availability

| Control | Implementation |
|---------|---------------|
| Rate limiting | Prevents DoS via sliding-window IP-based rate limiter |
| Body size limits | 10MB max for server actions, 1MB default for API routes |
| Health endpoint | `/api/health` reports system status (Supabase, AI keys, external services) |
| Error boundaries | `withGuard()` catches unhandled exceptions and returns sanitized errors |
| Non-root Docker | Container runs as `nextjs` user (UID 1001) |

---

## 3. Processing Integrity

| Control | Implementation | File(s) |
|---------|---------------|---------|
| Input validation | `validateBody()` validates type, length, and required fields | `src/lib/security/input-validator.ts` |
| UUID validation | `isValidUUID()` prevents injection via malformed IDs | `src/lib/security/input-validator.ts` |
| URL validation | `isValidUrl()` restricts to http/https protocols | `src/lib/security/input-validator.ts` |
| HTML escaping | `escapeHtml()` prevents XSS in user-generated content | `src/lib/security/input-validator.ts` |
| String sanitization | `sanitizeString()` strips control characters | `src/lib/security/input-validator.ts` |
| Type safety | TypeScript with strict checks enforced in production builds | `next.config.js` |

---

## 4. Confidentiality

| Control | Implementation |
|---------|---------------|
| Secrets management | All API keys stored in environment variables, never in code |
| Client/server separation | `NEXT_PUBLIC_` prefix only for non-sensitive values; AI keys are server-only |
| Error sanitization | Production errors return generic messages; details logged server-side only |
| API response caching | `Cache-Control: no-store` on all API routes |
| `.gitignore` | `.env.local` excluded from version control |
| `.env.example` | Documents all required variables without exposing real values |

---

## 5. Privacy

| Control | Implementation |
|---------|---------------|
| Data isolation | RLS policies enforce `user_id = auth.uid()` ownership |
| Audit trail | Immutable `audit_logs` table records all security events |
| Data retention | Configurable auto-purge for audit logs (pg_cron, 2-year default) |
| Minimal data collection | No tracking pixels, analytics, or third-party data sharing |
| Referrer control | `Referrer-Policy: strict-origin-when-cross-origin` |
| Feature restrictions | `Permissions-Policy` disables camera, microphone, geolocation |

---

## Audit Logging

All security-relevant events are recorded in the `audit_logs` table and written to structured stdout for log aggregation:

| Event Type | Description |
|-----------|-------------|
| `AUTH_LOGIN` | Successful authentication |
| `AUTH_FAILED` | Failed authentication attempt |
| `API_RATE_LIMITED` | Request rejected by rate limiter |
| `API_UNAUTHORIZED` | Request without valid credentials |
| `DATA_CREATE/READ/UPDATE/DELETE` | CRUD operations on resources |
| `SECURITY_VIOLATION` | Unhandled errors, suspicious activity |

Implementation: `src/lib/security/audit-logger.ts`

---

## Setup Checklist

### Production Deployment

1. **Generate secrets:**
   ```bash
   openssl rand -hex 32  # → DASHBOARD_API_SECRET
   ```

2. **Set environment variables** (Vercel/Fly.io secrets):
   - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase dashboard → Settings → API
   - `DASHBOARD_API_SECRET` — generated above
   - `ALLOWED_ORIGINS` — your production domain(s)

3. **Run security migration:**
   Execute `supabase-migration-security.sql` in Supabase SQL editor.

4. **Create first user:**
   Use Supabase dashboard → Authentication → Users → Invite user.

5. **Verify:**
   - Visit `/api/health` — should return system status
   - Visit `/login` — should show authentication page
   - Try accessing any dashboard page without auth — should redirect to `/login`

### Development

Leave `DASHBOARD_API_SECRET` empty in `.env.local` to disable auth enforcement locally.

---

## Architecture

```
Request → Edge Middleware (auth + headers + CORS)
            ↓
        API Route → withGuard() (rate limit + auth + validation + audit)
            ↓
        Business Logic → Supabase (RLS enforced)
            ↓
        Response ← Security headers injected
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `src/middleware.ts` | Edge Middleware: auth, headers, CORS |
| `src/lib/security/api-guard.ts` | API route protection wrapper |
| `src/lib/security/rate-limiter.ts` | Sliding-window rate limiter |
| `src/lib/security/input-validator.ts` | Input validation & sanitization |
| `src/lib/security/audit-logger.ts` | Security event audit logging |
| `src/lib/security/index.ts` | Re-exports all security utilities |
| `src/app/login/page.tsx` | Authentication page |
| `src/app/auth/callback/route.ts` | OAuth callback handler |
| `supabase-migration-security.sql` | RLS policies + audit table |
| `next.config.js` | Security headers + build safety |
| `.env.example` | Environment variable documentation |
| `SECURITY.md` | This document |
