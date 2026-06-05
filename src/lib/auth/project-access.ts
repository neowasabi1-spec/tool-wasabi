/**
 * Per-project access control used by the API routes that read / write
 * a project or its child rows (project_files, funnel_steps).
 *
 * Centralises the "owner OR master OR collaborator (project_shares row)
 * OR unauthenticated server-call" decision so every route applies the
 * same rule. Mirrors the SQL helper public.has_project_access used by
 * the matching RLS policies — keeping the two in sync means a malicious
 * caller can't bypass either layer.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  getUserAccessContext,
  type UserAccessContext,
} from './get-current-user';

export interface ProjectAccessDecision {
  ctx: UserAccessContext;
  /** True when the caller may read/write rows tied to this project. */
  allowed: boolean;
  /** Project owner UUID (null if the project doesn't exist or has no
   *  owner — e.g. legacy unmigrated rows). Useful for "shared with you"
   *  badges in the UI. */
  ownerUserId: string | null;
  /** True when the caller has access via a project_shares row (NOT via
   *  ownership / master). Lets the API decide whether to block
   *  destructive actions like deleting the whole project — those stay
   *  owner-only even for collaborators. */
  viaShare: boolean;
}

/**
 * Resolve whether `req` can touch the given project.
 *
 * Allowed cases:
 *   - No JWT at all (server-to-server, phase-1 fallback)
 *   - Master role
 *   - Project owner
 *   - User has a row in project_shares for this project
 *
 * Never throws. On lookup errors we fall closed (allowed=false) for
 * regular users — better to 404 than to leak a row by mistake.
 */
export async function canAccessProject(
  req: NextRequest,
  projectId: string,
): Promise<ProjectAccessDecision> {
  const ctx = await getUserAccessContext(req);

  // Legacy / server-to-server: phase-1 transitional behavior. Skip
  // every Supabase round-trip; we don't even need ownerUserId because
  // the caller is allowed regardless (and the field is only used for
  // the SHARED-vs-OWNED badge logic, which doesn't apply server-side).
  if (!ctx.userId) {
    return { ctx, allowed: true, ownerUserId: null, viaShare: false };
  }

  // Master sees everything. We deliberately DO NOT lookup the project
  // row here either: master is allowed regardless of who owns it, and
  // adding a Supabase round-trip to every API call the master makes
  // was just enough extra latency to push large PATCH requests
  // (funnel-step HTML save) past the Netlify 10s timeout, causing the
  // "Partial save" UI error even on healthy data. Callers that need
  // ownerUserId for UX purposes should fetch it themselves.
  if (ctx.isMaster) {
    return { ctx, allowed: true, ownerUserId: null, viaShare: false };
  }

  // Regular user: must be owner OR have a share row. We fetch both in
  // parallel so a slow Supabase round-trip doesn't double-block.
  const [{ data: project }, { data: share }] = await Promise.all([
    supabaseAdmin
      .from('projects')
      .select('owner_user_id')
      .eq('id', projectId)
      .maybeSingle(),
    supabaseAdmin
      .from('project_shares')
      .select('user_id')
      .eq('project_id', projectId)
      .eq('user_id', ctx.userId)
      .maybeSingle(),
  ]);

  const ownerUserId =
    (project as { owner_user_id?: string } | null)?.owner_user_id ?? null;
  const isOwner = ownerUserId === ctx.userId;
  const viaShare = !!share;

  return {
    ctx,
    allowed: isOwner || viaShare,
    ownerUserId,
    viaShare: !isOwner && viaShare,
  };
}

/**
 * Fetch the list of project IDs visible to the given user via either
 * direct ownership or a project_shares row. Used by /api/projects/list
 * and the projecthub /projects listing to merge owned + shared in one
 * pass without two round-trips per request.
 *
 * Returns BOTH sets so the caller can tell them apart (e.g. tag shared
 * rows with a "SHARED" badge in the UI). Master / unauth callers get
 * empty sets — those callers should just skip the filter entirely and
 * let RLS / the "see all" branch take over.
 */
export async function listAccessibleProjectIds(
  userId: string,
): Promise<{ ownedIds: Set<string>; sharedIds: Set<string> }> {
  const [{ data: owned }, { data: shared }] = await Promise.all([
    supabaseAdmin
      .from('projects')
      .select('id')
      .eq('owner_user_id', userId),
    supabaseAdmin
      .from('project_shares')
      .select('project_id')
      .eq('user_id', userId),
  ]);
  return {
    ownedIds: new Set(
      ((owned || []) as { id: string }[]).map((r) => r.id),
    ),
    sharedIds: new Set(
      ((shared || []) as { project_id: string }[]).map((r) => r.project_id),
    ),
  };
}
