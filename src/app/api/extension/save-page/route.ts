import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { canAccessProject } from '@/lib/auth/project-access';
import { absolutizeUrlsInHtml } from '@/lib/spa-rescue';
import { PAGE_TYPE_OPTIONS } from '@/types';

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

  const buildStep = () => ({
    step_index: 1,
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
  });

  // 1) Create the archive row (single step of the chosen type).
  const { data: created, error: insertErr } = await supabaseAdmin
    .from('archived_funnels')
    .insert({
      name,
      total_steps: 1,
      steps: [buildStep()],
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
  // ignored if the archive_categories table hasn't been migrated yet).
  if (category) {
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

  return NextResponse.json({
    success: true,
    pageId,
    pageType,
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
