import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { loadSlimArchivedFunnels, type SlimArchiveStep } from '@/lib/slim-archived-funnels';
import { resolvePageType, upsertArchivePageType } from '@/lib/archive-page-types';
import { dedupeStepsByUrl } from '@/lib/archive-placement';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Copy selected Competitor Landings into Templates → Pages
 * (archived_funnels with project_id null, section=page).
 *
 * Body: { items: [{ id, name, category, tags, page_type? }] }
 * Name, category and at least one tag are required on every item.
 * HTML is copied via page_html — never written back into steps JSONB.
 */

type SaveItem = {
  id: string;
  name: string;
  category: string;
  tags: string[];
  page_type?: string;
};

function parseLandingRef(raw: string): { rowId: string; stepIndex: number | null } {
  const i = String(raw || '').lastIndexOf('::');
  if (i < 0) return { rowId: String(raw || ''), stepIndex: null };
  const idx = Number(raw.slice(i + 2));
  if (!Number.isFinite(idx)) return { rowId: String(raw), stepIndex: null };
  return { rowId: raw.slice(0, i), stepIndex: idx };
}

const isDomainLike = (s: string) => !/\s/.test(s) && /\.[a-z]{2,}$/i.test(s.trim());

function htmlSourceId(step: SlimArchiveStep, rowId: string): string {
  if (step.page_id) return String(step.page_id);
  const u = String(step.cloned_data?.htmlUrl || '');
  const m = /[?&]pageId=([^&]+)/.exec(u);
  if (m?.[1]) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return rowId;
}

async function copyHtml(fromPageId: string, toPageId: string, ownerUserId: string | null): Promise<boolean> {
  if (!fromPageId || fromPageId === toPageId) return false;
  const { data } = await supabaseAdmin
    .from('page_html')
    .select('html')
    .eq('page_id', fromPageId)
    .eq('kind', 'cloned')
    .eq('variant', 'desktop')
    .maybeSingle();
  const html = typeof data?.html === 'string' ? data.html : '';
  if (html.length < 30) return false;
  const { error } = await supabaseAdmin.from('page_html').upsert(
    {
      page_id: toPageId,
      kind: 'cloned',
      variant: 'desktop',
      html,
      ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'page_id,kind,variant' },
  );
  if (error) {
    console.warn('[landings/save-to-templates] page_html copy failed:', error.message);
    return false;
  }
  return true;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id: projectId } = params;
  const { allowed, ctx, ownerUserId } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const userId = ctx.userId || ownerUserId;
  const body = await req.json().catch(() => ({}));
  const rawItems = Array.isArray(body.items) ? (body.items as SaveItem[]) : [];
  if (!rawItems.length) return NextResponse.json({ error: 'No landings selected' }, { status: 400 });
  if (rawItems.length > 20) {
    return NextResponse.json({ error: 'Save at most 20 pages at a time' }, { status: 400 });
  }

  const items = rawItems.map((it) => ({
    id: String(it.id || '').trim(),
    name: String(it.name || '').trim().slice(0, 120),
    category: String(it.category || '').trim().slice(0, 60),
    tags: (Array.isArray(it.tags) ? it.tags : [])
      .map((t) => String(t).trim())
      .filter(Boolean)
      .slice(0, 30),
    page_type: String(it.page_type || '').trim(),
  }));

  for (const it of items) {
    if (!it.id) return NextResponse.json({ error: 'Each page needs an id' }, { status: 400 });
    if (!it.name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    if (!it.category || isDomainLike(it.category)) {
      return NextResponse.json({ error: 'Category is required (not a domain)' }, { status: 400 });
    }
    if (!it.tags.length) return NextResponse.json({ error: 'At least one tag is required' }, { status: 400 });
  }

  const { rows, error } = await loadSlimArchivedFunnels(projectId, 400);
  if (error) return NextResponse.json({ error }, { status: 500 });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const saved: Array<{ id: string; name: string }> = [];
  const categories = new Set<string>();

  for (const item of items) {
    const { rowId, stepIndex } = parseLandingRef(item.id);
    const row = byId.get(rowId);
    if (!row) continue;
    const raw = (row.steps.length ? row.steps : [{ page_id: row.id, cloned_data: {} }]) as Record<string, unknown>[];
    const steps = (dedupeStepsByUrl(raw) as SlimArchiveStep[]);
    const step = (stepIndex != null ? steps[stepIndex] : steps[0]) || steps[0];
    if (!step) continue;

    const resolved = resolvePageType(item.page_type || step.page_type || 'landing');
    const cd = step.cloned_data || {};
    const sourceUrl = String(cd.source_url || step.url_to_swipe || '');
    const sourcePageId = htmlSourceId(step, row.id);
    const newId = randomUUID();
    const htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(newId)}&kind=cloned&variant=desktop`;

    const clonedData = {
      source_url: sourceUrl,
      screenshotDesktopUrl: cd.screenshotDesktopUrl || null,
      screenshotMobileUrl: cd.screenshotMobileUrl || null,
      htmlUrl,
      category: item.category,
      tags: item.tags,
    };
    const newStep = {
      step_index: 1,
      name: item.name,
      page_type: resolved.value,
      category: item.category,
      tags: item.tags,
      template_name: '',
      product_name: '',
      url_to_swipe: sourceUrl,
      prompt: '',
      feedback: '',
      swipe_status: 'completed',
      swipe_result: '',
      swiped_data: null,
      cloned_data: clonedData,
      page_id: newId,
    };

    const { error: insErr } = await supabaseAdmin.from('archived_funnels').insert({
      id: newId,
      name: item.name,
      total_steps: 1,
      steps: [newStep],
      section: 'page',
      project_id: null,
      ...(userId ? { owner_user_id: userId } : {}),
    });
    if (insErr) {
      console.warn('[landings/save-to-templates] insert failed:', insErr.message);
      continue;
    }

    await copyHtml(sourcePageId, newId, userId);
    if (resolved.isCustom && userId) {
      await upsertArchivePageType(userId, resolved.value, resolved.label);
    }
    categories.add(item.category);
    saved.push({ id: newId, name: item.name });
  }

  if (userId) {
    for (const name of categories) {
      await supabaseAdmin
        .from('archive_categories')
        .upsert({ name, owner_user_id: userId }, { onConflict: 'owner_user_id,name' })
        .then(() => undefined, () => undefined);
    }
  }

  if (!saved.length) {
    return NextResponse.json({ error: 'Could not copy any landing into Templates' }, { status: 500 });
  }
  return NextResponse.json({ saved: saved.length, items: saved });
}
