import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  engineCreateJob,
  engineGetJob,
  engineHealth,
  engineListJobs,
  isReelEngineConfigured,
  mediaBuyerSlugFromUser,
} from '@/lib/reel/engine-client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function resolveMediaBuyer(userId: string | null): Promise<string> {
  if (!userId) return mediaBuyerSlugFromUser({ id: null, email: null });
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    return mediaBuyerSlugFromUser({
      id: userId,
      email: data?.user?.email ?? null,
      name:
        typeof data?.user?.user_metadata?.full_name === 'string'
          ? data.user.user_metadata.full_name
          : null,
    });
  } catch {
    return mediaBuyerSlugFromUser({ id: userId });
  }
}

/**
 * GET  /api/projecthub/projects/:id/reel/jobs?jobId=…
 * POST /api/projecthub/projects/:id/reel/jobs
 * Proxies to the Claude Cloud reel engine. No MCP in the browser.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed, ctx } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!isReelEngineConfigured()) {
    return NextResponse.json(
      {
        configured: false,
        error: 'Reel engine offline — set REEL_ENGINE_URL on Netlify when the Claude Cloud host is up.',
      },
      { status: 503 },
    );
  }

  const jobId = req.nextUrl.searchParams.get('jobId');
  try {
    if (jobId) {
      const job = await engineGetJob(jobId);
      if (job.projectId !== projectId) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ configured: true, job });
    }
    const mediaBuyer = await resolveMediaBuyer(ctx.userId);
    const jobs = await engineListJobs({ projectId, mediaBuyer, limit: 30 });
    const health = await engineHealth();
    return NextResponse.json({ configured: true, health, mediaBuyer, jobs });
  } catch (e) {
    return NextResponse.json(
      { configured: true, error: e instanceof Error ? e.message : 'Engine error' },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id;
  const { allowed, ctx } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!isReelEngineConfigured()) {
    return NextResponse.json(
      {
        error:
          'Reel engine not connected. The Claude Cloud host must be running and REEL_ENGINE_URL set on Wasabi.',
      },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const mediaBuyer = await resolveMediaBuyer(ctx.userId);

  try {
    const job = await engineCreateJob({
      kind: (body.kind as 'import' | 'produce' | 'publish') || 'produce',
      mediaBuyer,
      projectId,
      brandId: body.brandId != null ? Number(body.brandId) : undefined,
      brief: typeof body.brief === 'string' ? body.brief.slice(0, 4000) : undefined,
      slug: typeof body.slug === 'string' ? body.slug : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      includeFullAds: body.includeFullAds !== false,
    });
    return NextResponse.json({ ok: true, mediaBuyer, job });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Create job failed' },
      { status: 502 },
    );
  }
}
