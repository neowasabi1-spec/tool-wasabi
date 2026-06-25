/**
 * Master-only impersonation, resolved server-side.
 *
 * How it works
 * ────────────
 * The client (master) keeps its OWN Supabase session/JWT as usual. When the
 * master chooses to "impersonate" a user, the client adds an extra header
 * `X-Impersonate-User: <targetUserId>` to every same-origin /api/* request
 * (see install-fetch-interceptor.ts). The real Authorization bearer token
 * still belongs to the master.
 *
 * Server-side we ONLY honor that header when the REAL caller (the verified
 * JWT) is a master. A normal user setting the header gets ignored, so this
 * cannot be used for privilege escalation. While impersonating, the effective
 * role is forced to a plain user (isMaster=false) so the master sees EXACTLY
 * what the target user sees and cannot accidentally escalate via the target.
 *
 * This is the single chokepoint used by getCurrentUserId /
 * getUserAccessContext / requireAuth, so impersonation transparently flows
 * through every owner-tagging insert and every owner-filtered read.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const IMPERSONATE_HEADER = 'x-impersonate-user';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Reads + validates the impersonation target user id from the request
 *  header. Returns null when absent or malformed. */
export function extractImpersonationTarget(req: NextRequest): string | null {
  const v = req.headers.get(IMPERSONATE_HEADER);
  if (!v) return null;
  const t = v.trim();
  return UUID_RE.test(t) ? t : null;
}

/** True if the given user id has the 'master' role. Never throws. */
export async function isMasterUser(userId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin
      .from('app_user_permissions')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();
    return data?.role === 'master';
  } catch {
    return false;
  }
}

export interface EffectiveUser {
  /** The user id every downstream read/write should use. */
  effectiveUserId: string;
  /** True only when a master is currently impersonating someone else. */
  impersonating: boolean;
}

/**
 * Given the REAL authenticated user id (verified from the JWT), resolve the
 * effective user id after honoring an impersonation header. The header is
 * ignored unless the real caller is a master. Never throws.
 */
export async function resolveEffectiveUserId(
  req: NextRequest,
  realUserId: string,
): Promise<EffectiveUser> {
  const target = extractImpersonationTarget(req);
  if (!target || target === realUserId) {
    return { effectiveUserId: realUserId, impersonating: false };
  }
  if (!(await isMasterUser(realUserId))) {
    return { effectiveUserId: realUserId, impersonating: false };
  }
  return { effectiveUserId: target, impersonating: true };
}
