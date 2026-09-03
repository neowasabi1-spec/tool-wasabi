import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { canAccessProject } from '@/lib/auth/project-access';
import { absolutizeUrlsInHtml } from '@/lib/spa-rescue';
import { PAGE_TYPE_OPTIONS } from '@/types';
import { inferPageType, isUpsellType, isDownsellType } from '@/lib/server/page-type-classifier';
import { canonPageUrl, dedupeStepsByUrl, stepSourceUrl } from '@/lib/archive-placement';
import { extractLandingMediaFromHtml } from '@/lib/landing-media';

async function saveLandingMedia(projectId: string | null, html: string, pageUrl: string) {
  if (!projectId || !html) return;
  try {
    await extractLandingMediaFromHtml(supabaseAdmin, {
      projectId,
      html,
      pageUrl,
      limit: 16,
    });
  } catch (e) {
    console.warn('[save-page] landing media extract:', (e as Error).message);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Composite "save from the browser extension" endpoint.
 *
 * The extension captures the page AS THE USER SEES IT (rendered DOM +
 * desktop/mobile screenshots) and posts it here. We save it as a single-step
 * `archived_funnels` row of the chosen PAGE TYPE, so it shows up in
 * My Archive → "By Type" (and "Saved Funnels"), exactly like the app's own
 * archive entries. The HTML is stored inline in the step's `cloned_data.html`
 * (what the archive preview reads) and mirrored into `page_html` so the
 * standalone editor (/edit/[id]) can load and edit it.
 *
 * Auth: per-user Supabase access token (Authorization: Bearer <token>).
 */

interface SaveBody {
  url?: string;
  title?: string;
  name?: string;
  html?: string;
  screenshots?: { desktop?: string; mobile?: string };
  // Storage paths for screenshots already uploaded via /api/extension/sign-shot
  // (the extension uploads them directly to bypass the 6MB body limit).
  screenshotDesktopPath?: string;
  screenshotMobilePath?: string;
  pageType?: string;
  folderId?: string | null; // legacy — treated as pageType if pageType absent
  category?: string;
  tags?: string[];
  projectId?: string | null; // when set, link the page to a project's Competitor Landings
  // Funnel-walk mode: instead of one single-step row per page, all the steps of
  // a walked funnel go into ONE `archived_funnels` row (the "folder"). The first
  // step creates the folder and returns its `funnelId`; every next step passes
  // that `funnelId` (+ stepIndex) so it is appended to the same folder.
  funnelGroup?: boolean;
  funnelId?: string | null;
  funnelName?: string; // folder name (usually the funnel domain)
  stepIndex?: number;
}

const VALID_TYPES = new Set(PAGE_TYPE_OPTIONS.map((o) => o.value as string));

function decodeDataUrl(input: string): { buffer: Buffer; contentType: string } | null {
  const m = input.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
  const base64 = m ? m[2] : input;
  const contentType = m ? m[1] : 'image/png';
  try {
    return { buffer: Buffer.from(base64, 'base64'), contentType };
  } catch {
    return null;
  }
}

async function uploadScreenshot(
  pageId: string,
  variant: 'desktop' | 'mobile',
  dataUrl: string,
): Promise<string | null> {
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded || decoded.buffer.length === 0) return null;
  const ext = decoded.contentType.includes('jpeg') ? 'jpg' : 'png';
  const path = `extension-captures/${pageId}/${variant}.${ext}`;
  const { error } = await supabaseAdmin.storage
    .from('media')
    .upload(path, decoded.buffer, { contentType: decoded.contentType, upsert: true });
  if (error) {
    console.warn(`[extension/save-page] screenshot ${variant} upload failed:`, error.message);
    return null;
  }
  const { data } = supabaseAdmin.storage.from('media').getPublicUrl(path);
  return data.publicUrl;
}

// Turn a pre-uploaded storage path (from /api/extension/sign-shot) into a public
// URL. Guarded to our capture prefix so an arbitrary path can't be surfaced.
function publicUrlForShotPath(storagePath: string): string | null {
  const clean = String(storagePath || '').replace(/^\/+/, '');
  if (!clean.startsWith('extension-captures/')) return null;
  const { data } = supabaseAdmin.storage.from('media').getPublicUrl(clean);
  return data.publicUrl || null;
}

export async function POST(req: NextRequest) {
  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  const userId = await getCurrentUserId(req);
  if (!userId) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Connect the extension to your account first.' },
      { status: 401 },
    );
  }

  const url = (body.url || '').trim();
  if (!url) return NextResponse.json({ error: 'url is required' }, { status: 400 });
  if (!body.html || body.html.length < 30) {
    return NextResponse.json({ error: 'html is required' }, { status: 400 });
  }

  const title = (body.title || '').trim();
  const name =
    (body.name || '').trim() ||
    title ||
    (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return 'Saved page';
      }
    })();
  const tags = Array.isArray(body.tags)
    ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 30)
    : [];

  const requestedType = String(body.pageType || body.folderId || 'landing');
  const pageType = VALID_TYPES.has(requestedType) ? requestedType : 'landing';
  const category = String(body.category || '').trim().slice(0, 60);

  // During a funnel walk the popup does not ask a type per step, so the
  // request degrades to 'landing' for EVERY page — checkouts, upsells and
  // thank-you pages all landed in the "Landing Page" folder. When the type
  // is missing/default we infer the real one from URL + title + HTML.
  // An explicit non-landing choice from the user is always respected.
  const typeWasExplicit = VALID_TYPES.has(requestedType) && requestedType !== 'landing';

  // Optionally link the saved page to a project (Competitor Landings). Only
  // honored when the user actually has access to that project.
  let projectId: string | null = null;
  const requestedProjectId = String(body.projectId || '').trim();
  if (requestedProjectId) {
    const { allowed } = await canAccessProject(req, requestedProjectId);
    if (allowed) projectId = requestedProjectId;
  }

  // Absolutize relative URLs so the saved snapshot renders standalone.
  let html = body.html;
  try {
    html = absolutizeUrlsInHtml(html, url);
  } catch {
    /* keep raw html on failure */
  }

  const clonedData: Record<string, unknown> = {
    html,
    title,
    source_url: url,
    method_used: 'extension',
    cloned_at: new Date().toISOString(),
    category,
    tags,
  };

  // ── Funnel-walk mode: one folder row, many steps ──────────────────────────
  // Each captured page becomes a STEP inside a single archived_funnels row so
  // the walked funnel reads as ONE multi-step folder (and shows up in the
  // Chimera "Funnel to build" picker), instead of N loose single-step rows.
  if (body.funnelGroup) {
    const stepIndex = Number(body.stepIndex) > 0 ? Math.floor(Number(body.stepIndex)) : 1;
    // Per-step storage key (page_html.page_id is free text, no FK) so every step
    // keeps its own HTML mirror + screenshots + editor link.
    const stepPageId = randomUUID();

    const shots = body.screenshots || {};
    const resolveShot = (
      variant: 'desktop' | 'mobile',
      storagePath?: string,
      dataUrl?: string,
    ): Promise<string | null> => {
      if (storagePath) return Promise.resolve(publicUrlForShotPath(storagePath));
      if (dataUrl) return uploadScreenshot(stepPageId, variant, dataUrl);
      return Promise.resolve(null);
    };
    const [desktopUrl, mobileUrl] = await Promise.all([
      resolveShot('desktop', body.screenshotDesktopPath, shots.desktop),
      resolveShot('mobile', body.screenshotMobilePath, shots.mobile),
    ]);

    const { error: htmlErr } = await supabaseAdmin.from('page_html').upsert(
      { page_id: stepPageId, kind: 'cloned', variant: 'desktop', html, owner_user_id: userId, updated_at: new Date().toISOString() },
      { onConflict: 'page_id,kind,variant' },
    );
    if (htmlErr) console.warn('[extension/save-page] page_html upsert failed:', htmlErr.message);
    const htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(stepPageId)}&kind=cloned&variant=desktop&v=${Date.now()}`;

    clonedData.screenshotDesktopUrl = desktopUrl;
    clonedData.screenshotMobileUrl = mobileUrl;
    clonedData.htmlUrl = htmlUrl;

    const step = {
      step_index: stepIndex,
      name,
      page_type: pageType,
      category,
      template_name: '',
      product_name: '',
      url_to_swipe: url,
      prompt: '',
      feedback: '',
      swipe_status: 'completed',
      swipe_result: '',
      swiped_data: null,
      cloned_data: clonedData,
      page_id: stepPageId,
    };

    // NOTE: in funnel-walk mode `category` is the funnel DOMAIN (used only for
    // folder grouping) — it must NOT be registered as a user category, or the
    // popup's Category picker fills up with domains. So no archive_categories
    // upsert here on purpose.

    const folderName = String(body.funnelName || category || name).slice(0, 120);
    let existingId = String(body.funnelId || '').trim();

    // Reuse an existing folder of the same name + destination (template vs
    // competitor project) so a second walk doesn't create a twin funnel.
    if (!existingId && folderName) {
      let q = supabaseAdmin
        .from('archived_funnels')
        .select('id, steps, owner_user_id, project_id')
        .eq('owner_user_id', userId)
        .eq('name', folderName);
      q = projectId ? q.eq('project_id', projectId) : q.is('project_id', null);
      const { data: twins } = await q.order('created_at', { ascending: false }).limit(8);
      if (twins && twins.length > 0) existingId = String(twins[0].id);
    }

    // Append to an existing folder the caller owns.
    if (existingId) {
      const { data: row } = await supabaseAdmin
        .from('archived_funnels')
        .select('id, steps, owner_user_id')
        .eq('id', existingId)
        .maybeSingle();
      if (row && row.owner_user_id === userId) {
        const rawSteps = Array.isArray(row.steps) ? (row.steps as Record<string, unknown>[]) : [];
        const steps = dedupeStepsByUrl(rawSteps);
        const incoming = canonPageUrl(url);
        const already = incoming
          ? steps.find((s) => canonPageUrl(stepSourceUrl(s as { url_to_swipe?: unknown; cloned_data?: { source_url?: unknown } })) === incoming)
          : undefined;
        if (already) {
          if (steps.length !== rawSteps.length) {
            await supabaseAdmin
              .from('archived_funnels')
              .update({ steps, total_steps: steps.length, section: 'funnel' })
              .eq('id', existingId);
          }
          const existingPageId = String((already as { page_id?: string }).page_id || existingId);
          return NextResponse.json({
            success: true,
            duplicate: true,
            funnelId: existingId,
            stepIndex: Number((already as { step_index?: number }).step_index) || steps.length,
            pageId: existingPageId,
            projectId,
            htmlUrl: String((already as { cloned_data?: { htmlUrl?: string } }).cloned_data?.htmlUrl || htmlUrl),
            editorUrl: `/edit/${existingPageId}`,
            screenshotDesktopUrl: desktopUrl,
            screenshotMobileUrl: mobileUrl,
          });
        }
        if (!typeWasExplicit) {
          const prior = steps as Array<{ page_type?: string }>;
          step.page_type = inferPageType({
            url,
            title,
            name,
            html,
            upsellsSeen: prior.filter((s) => isUpsellType(String(s?.page_type || ''))).length,
            downsellsSeen: prior.filter((s) => isDownsellType(String(s?.page_type || ''))).length,
          });
        }
        steps.push(step);
        await supabaseAdmin
          .from('archived_funnels')
          .update({
            steps,
            total_steps: steps.length,
            section: 'funnel',
            ...(projectId ? { project_id: projectId } : {}),
          })
          .eq('id', existingId);
        await saveLandingMedia(projectId, html, url);
        return NextResponse.json({
          success: true,
          funnelId: existingId,
          stepIndex,
          pageId: stepPageId,
          projectId,
          htmlUrl,
          editorUrl: `/edit/${stepPageId}`,
          screenshotDesktopUrl: desktopUrl,
          screenshotMobileUrl: mobileUrl,
        });
      }
      // Not found / not owned → fall through and start a fresh folder.
    }

    // First step → create the folder row.
    if (!typeWasExplicit) {
      step.page_type = inferPageType({ url, title, name, html });
    }
    const { data: createdFolder, error: folderErr } = await supabaseAdmin
      .from('archived_funnels')
      .insert({
        name: folderName,
        total_steps: 1,
        steps: [step],
        section: 'funnel',
        owner_user_id: userId,
        ...(projectId ? { project_id: projectId } : {}),
      })
      .select('id')
      .single();
    if (folderErr || !createdFolder) {
      return NextResponse.json(
        { error: `Could not create funnel folder: ${folderErr?.message || 'unknown'}` },
        { status: 500 },
      );
    }
    await saveLandingMedia(projectId, html, url);
    return NextResponse.json({
      success: true,
      funnelId: createdFolder.id,
      stepIndex,
      pageId: stepPageId,
      projectId,
      htmlUrl,
      editorUrl: `/edit/${stepPageId}`,
      screenshotDesktopUrl: desktopUrl,
      screenshotMobileUrl: mobileUrl,
    });
  }

  // Old-style walks saved each step as its own single row named
  // "<domain> — Step N" (no funnelGroup flag): infer the type for those too.
  const looksLikeWalkStep = /—\s*Step\s+\d+\s*$/i.test(name);
  const effectiveType =
    !typeWasExplicit && looksLikeWalkStep ? inferPageType({ url, title, name, html }) : pageType;

  const buildStep = () => ({
    step_index: 1,
    name,
    page_type: effectiveType,
    category,
    template_name: '',
    product_name: '',
    url_to_swipe: url,
    prompt: '',
    feedback: '',
    swipe_status: 'completed',
    swipe_result: '',
    swiped_data: null,
    cloned_data: clonedData,
  });

  // 1) Create the archive row (single step of the chosen type).
  const { data: created, error: insertErr } = await supabaseAdmin
    .from('archived_funnels')
    .insert({
      name,
      total_steps: 1,
      steps: [buildStep()],
      section: 'page',
      owner_user_id: userId,
      ...(projectId ? { project_id: projectId } : {}),
    })
    .select('id')
    .single();

  if (insertErr || !created) {
    return NextResponse.json(
      { error: `Could not create archive entry: ${insertErr?.message || 'unknown'}` },
      { status: 500 },
    );
  }

  const pageId: string = created.id;

  // Register the category so it appears in the picker next time (best-effort;
  // ignored if the archive_categories table hasn't been migrated yet). Skip
  // domain-like values so a domain never ends up in the Category picker.
  const isDomainLike = (s: string) => !/\s/.test(s) && /\.[a-z]{2,}$/i.test(s.trim());
  if (category && !isDomainLike(category)) {
    try {
      await supabaseAdmin
        .from('archive_categories')
        .upsert({ name: category, owner_user_id: userId }, { onConflict: 'owner_user_id,name' });
    } catch {
      /* table may not exist yet */
    }
  }

  // 2) Resolve screenshots (best-effort). Preferred path: the extension already
  // uploaded them via signed URLs and sent only the storage paths (keeps the
  // body small). Fallback: legacy inline base64 for older extension versions.
  const shots = body.screenshots || {};
  const resolveShot = (
    variant: 'desktop' | 'mobile',
    storagePath?: string,
    dataUrl?: string,
  ): Promise<string | null> => {
    if (storagePath) return Promise.resolve(publicUrlForShotPath(storagePath));
    if (dataUrl) return uploadScreenshot(pageId, variant, dataUrl);
    return Promise.resolve(null);
  };
  const [desktopUrl, mobileUrl] = await Promise.all([
    resolveShot('desktop', body.screenshotDesktopPath, shots.desktop),
    resolveShot('mobile', body.screenshotMobilePath, shots.mobile),
  ]);

  // 3) Mirror the HTML into page_html so the standalone editor can load it.
  const { error: htmlErr } = await supabaseAdmin.from('page_html').upsert(
    {
      page_id: pageId,
      kind: 'cloned',
      variant: 'desktop',
      html,
      owner_user_id: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'page_id,kind,variant' },
  );
  if (htmlErr) console.warn('[extension/save-page] page_html upsert failed:', htmlErr.message);
  const htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(pageId)}&kind=cloned&variant=desktop&v=${Date.now()}`;

  // 4) Patch the step's cloned_data with screenshot URLs + htmlUrl.
  clonedData.screenshotDesktopUrl = desktopUrl;
  clonedData.screenshotMobileUrl = mobileUrl;
  clonedData.htmlUrl = htmlUrl;
  await supabaseAdmin
    .from('archived_funnels')
    .update({ steps: [buildStep()] })
    .eq('id', pageId);

  const editorUrl = `/edit/${pageId}?src=${encodeURIComponent(url)}&title=${encodeURIComponent(name)}`;

  await saveLandingMedia(projectId, html, url);
  return NextResponse.json({
    success: true,
    pageId,
    pageType: effectiveType,
    category,
    name,
    tags,
    projectId,
    htmlUrl,
    editorUrl,
    screenshotDesktopUrl: desktopUrl,
    screenshotMobileUrl: mobileUrl,
  });
}
