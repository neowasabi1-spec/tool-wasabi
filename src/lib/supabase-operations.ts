import { supabase } from './supabase';
import { slugifyPageTypeLabel } from '@/types';
import type {
  Product,
  ProductInsert,
  ProductUpdate,
  Project,
  ProjectInsert,
  ProjectUpdate,
  SwipeTemplate,
  SwipeTemplateInsert,
  SwipeTemplateUpdate,
  FunnelPage,
  FunnelPageInsert,
  FunnelPageUpdate,
  PageType,
  PostPurchasePage,
  PostPurchasePageInsert,
  PostPurchasePageUpdate,
  FunnelCrawlStepRow,
  FunnelCrawlStepInsert,
  AffiliateBrowserChat,
  AffiliateBrowserChatInsert,
  AffiliateBrowserChatUpdate,
  AffiliateSavedFunnel,
  AffiliateSavedFunnelInsert,
  ScheduledBrowserJob,
  ScheduledBrowserJobInsert,
  ScheduledBrowserJobUpdate,
  SavedPrompt,
  SavedPromptInsert,
  SavedPromptUpdate,
  ArchivedFunnel,
  ArchivedFunnelInsert,
  Json,
} from '@/types/database';

type ArchivedFunnelUpdate = import('@/types/database').Database['public']['Tables']['archived_funnels']['Update'];

// =====================================================
// PRODUCTS OPERATIONS
// =====================================================

export async function fetchProducts(): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching products:', error);
    throw error;
  }
  return data || [];
}

export async function createProduct(product: ProductInsert): Promise<Product> {
  const { data, error } = await supabase
    .from('products')
    .insert(product)
    .select()
    .single();
  
  if (error) {
    console.error('Error creating product:', error);
    throw error;
  }
  return data;
}

export async function updateProduct(id: string, updates: ProductUpdate): Promise<Product> {
  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  
  if (error) {
    console.error('Error updating product:', error);
    throw error;
  }
  return data;
}

export async function deleteProduct(id: string): Promise<void> {
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', id);
  
  if (error) {
    console.error('Error deleting product:', error);
    throw error;
  }
}

// =====================================================
// PROJECTS OPERATIONS
// =====================================================

export async function fetchProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching projects:', error);
    throw error;
  }
  return data || [];
}

export async function createProject(project: ProjectInsert): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .insert(project)
    .select()
    .single();
  
  if (error) {
    console.error('Error creating project:', error);
    throw error;
  }
  return data;
}

export async function updateProject(id: string, updates: ProjectUpdate): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  
  if (error) {
    console.error('Error updating project:', error);
    throw error;
  }
  return data;
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', id);
  
  if (error) {
    console.error('Error deleting project:', error);
    throw error;
  }
}

// =====================================================
// SWIPE TEMPLATES OPERATIONS
// =====================================================

export async function fetchTemplates(): Promise<SwipeTemplate[]> {
  // Read the SHARED template catalog through the server endpoint, which
  // uses the service-role client and bypasses the per-owner RLS SELECT
  // policy. Reading directly from `swipe_templates` here would filter to
  // the caller's own rows (a regular user saw only 4 templates while the
  // master saw all 19). The global fetch interceptor attaches the JWT.
  try {
    const res = await fetch('/api/templates', { cache: 'no-store' });
    if (res.ok) {
      return (await res.json()) as SwipeTemplate[];
    }
    console.error('Error fetching templates: HTTP', res.status);
  } catch (err) {
    console.error('Error fetching templates via API, falling back to direct read:', err);
  }
  // Fallback (SSR / interceptor not installed): direct read, RLS-scoped.
  const { data, error } = await supabase
    .from('swipe_templates')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Error fetching templates:', error);
    throw error;
  }
  return data || [];
}

export async function createTemplate(template: SwipeTemplateInsert): Promise<SwipeTemplate> {
  const requested = sanitizePageTypeForDb(template.page_type);
  let payload: SwipeTemplateInsert = { ...template, page_type: requested };
  let { data, error } = await supabase
    .from('swipe_templates')
    .insert(payload)
    .select()
    .single();

  if (error && isPageTypeEnumError(error)) {
    payload = { ...payload, page_type: legacyEnumPageType(requested) };
    const retry = await supabase.from('swipe_templates').insert(payload).select().single();
    data = retry.data;
    error = retry.error;
    if (!error && data) return withRequestedPageType(data, requested);
  }

  if (error) {
    console.error('Error creating template:', error);
    throw error;
  }
  return data!;
}

export async function updateTemplate(id: string, updates: SwipeTemplateUpdate): Promise<SwipeTemplate> {
  const requested =
    updates.page_type !== undefined ? sanitizePageTypeForDb(updates.page_type) : undefined;
  let payload: SwipeTemplateUpdate = {
    ...updates,
    ...(requested !== undefined ? { page_type: requested } : {}),
  };
  let { data, error } = await supabase
    .from('swipe_templates')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error && requested !== undefined && isPageTypeEnumError(error)) {
    payload = { ...payload, page_type: legacyEnumPageType(requested) };
    const retry = await supabase.from('swipe_templates').update(payload).eq('id', id).select().single();
    data = retry.data;
    error = retry.error;
    if (!error && data) return withRequestedPageType(data, requested);
  }

  if (error) {
    console.error('Error updating template:', error);
    throw error;
  }
  return requested !== undefined && data ? withRequestedPageType(data, requested) : data!;
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await supabase
    .from('swipe_templates')
    .delete()
    .eq('id', id);
  
  if (error) {
    console.error('Error deleting template:', error);
    throw error;
  }
}

// =====================================================
// FUNNEL PAGES OPERATIONS
// =====================================================

export async function fetchFunnelPages(): Promise<FunnelPage[]> {
  try {
    const headers: Record<string, string> = {};
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem('wasabi_session');
        const token = raw ? (JSON.parse(raw) as { access_token?: string }).access_token : '';
        if (token) headers.Authorization = `Bearer ${token}`;
      } catch { /* ignore */ }
    }
    const res = await fetch('/api/funnel-pages', { cache: 'no-store', headers });
    if (res.ok) {
      const rows = (await res.json()) as FunnelPage[];
      if (Array.isArray(rows)) return rows;
    }
  } catch (e) {
    console.warn('[funnel_pages] API list failed, falling back to RLS:', (e as Error).message);
  }

  const { data, error } = await supabase
    .from('funnel_pages')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching funnel pages:', error);
    throw error;
  }
  return data || [];
}

// =====================================================
// PAGE TYPE SANITIZATION
// =====================================================
// Clone/Swipe TYPE used to collapse everything outside the original 8-value
// enum (`landing`, `checkout`, `product_page`, …) to `altro`. The native
// <select> has no `altro` option, so the browser displayed the first option
// (Bridge Page). Persist the slug the user picked; if the column is still an
// enum and Postgres rejects it (22P02), retry with a legacy fallback but keep
// the requested type on the returned row so the UI does not jump.

const LEGACY_ENUM_PAGE_TYPES = new Set<string>([
  '5_reasons_listicle',
  'quiz_funnel',
  'landing',
  'product_page',
  'safe_page',
  'checkout',
  'advertorial',
  'altro',
]);

const PAGE_TYPE_ENUM_FALLBACK: Record<string, string> = {
  listicle: '5_reasons_listicle',
  '5_reasons_listicle': '5_reasons_listicle',
  native_ad: 'advertorial',
  advertorial: 'advertorial',
  blog: 'advertorial',
  article: 'advertorial',
  content_page: 'advertorial',
  review: 'advertorial',
  vsl: 'landing',
  webinar: 'landing',
  bridge_page: 'landing',
  landing: 'landing',
  opt_in: 'landing',
  squeeze_page: 'landing',
  lead_magnet: 'landing',
  quiz: 'quiz_funnel',
  quiz_funnel: 'quiz_funnel',
  survey: 'quiz_funnel',
  assessment: 'quiz_funnel',
  lst: 'product_page',
  tsl: 'product_page',
  sales_letter: 'product_page',
  product_page: 'product_page',
  offer_page: 'product_page',
  checkout: 'checkout',
  order_confirmation: 'checkout',
  thank_you: 'altro',
  upsell: 'altro',
  upsell_1: 'altro',
  upsell_2: 'altro',
  upsell_3: 'altro',
  downsell: 'altro',
  downsell_1: 'altro',
  downsell_2: 'altro',
  downsell_3: 'altro',
  oto: 'altro',
  membership: 'altro',
  safe_page: 'safe_page',
  privacy: 'safe_page',
  terms: 'safe_page',
  disclaimer: 'safe_page',
  other: 'altro',
  altro: 'altro',
};

export function sanitizePageTypeForDb(value: PageType | undefined | null): PageType {
  const raw = String(value || '').trim();
  if (!raw) return 'landing';
  const slug = slugifyPageTypeLabel(raw) || raw;
  return (slug || 'landing') as PageType;
}

function legacyEnumPageType(value: PageType | undefined | null): PageType {
  const slug = String(sanitizePageTypeForDb(value) || '').toLowerCase();
  if (LEGACY_ENUM_PAGE_TYPES.has(slug)) return slug as PageType;
  const mapped = PAGE_TYPE_ENUM_FALLBACK[slug];
  return (mapped || 'altro') as PageType;
}

function isPageTypeEnumError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = String((err as { code?: unknown }).code || '');
  const msg = String((err as { message?: unknown }).message || '');
  return code === '22P02' || /invalid input value for enum page_type/i.test(msg);
}

function withRequestedPageType<T extends { page_type?: PageType | string | null }>(
  row: T,
  requested: PageType,
): T {
  return { ...row, page_type: requested };
}

// Postgres `statement_timeout` for the Supabase `anon` role is 3s by default.
// `cloned_data` / `swiped_data` / `extracted_data` are JSONB and the app
// historically dropped the entire rendered HTML inside them. On a heavy
// landing (Funnelish/ClickFunnels SPA snapshots → 1-5 MB) the UPDATE on the
// TOAST chain blows past 3s and Postgres kills it with `57014 statement
// timeout`. The user sees "Error updating funnel page" + the downstream
// /api/funnel-swap-proxy returns a generic 500.
//
// Fix: never persist the raw `html` blob in those JSONB columns. We keep
// metadata (size, length, source url, timestamps, title, method) so the UI
// can show "previously cloned" state, but the actual HTML stays in
// in-memory Zustand state only. If the user reloads, the next
// clone/extract will repopulate it on demand.
const HTML_PERSIST_THRESHOLD = 50_000; // 50 KB — small enough to never trip the timeout

function stripHtmlFromJsonb(jsonb: unknown): unknown {
  if (!jsonb || typeof jsonb !== 'object' || Array.isArray(jsonb)) return jsonb;
  const obj = jsonb as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const key of ['html', 'mobileHtml', 'htmlMobile', 'rawHtml', 'renderedHtml', 'content']) {
    const val = obj[key];
    if (typeof val === 'string' && val.length > HTML_PERSIST_THRESHOLD) {
      if (!out) out = { ...obj };
      delete out[key];
      out[`${key}Length`] = val.length;
      out[`${key}Skipped`] = true;
    }
  }
  return out ?? jsonb;
}

function sanitizeFunnelPagePayload<T extends Partial<FunnelPageInsert | FunnelPageUpdate>>(
  payload: T,
): T {
  const out = { ...payload } as Record<string, unknown>;
  if (out.cloned_data !== undefined) out.cloned_data = stripHtmlFromJsonb(out.cloned_data);
  if (out.swiped_data !== undefined) out.swiped_data = stripHtmlFromJsonb(out.swiped_data);
  if (out.extracted_data !== undefined) out.extracted_data = stripHtmlFromJsonb(out.extracted_data);
  return out as T;
}

// Columns on `funnel_pages` that arrived in a later migration and may not
// exist yet on a given deploy. When Postgres rejects the write because one of
// them is missing we drop it and retry, so the rest of the row still saves.
//   angle         → supabase-migration-funnel-pages-angle.sql
//   checkout_mode → supabase-migration-funnel-pages-checkout-mode.sql
const OPTIONAL_FUNNEL_PAGE_COLUMNS = ['angle', 'checkout_mode'] as const;

const OPTIONAL_COLUMN_MIGRATION: Record<string, string> = {
  angle: 'supabase-migration-funnel-pages-angle.sql',
  checkout_mode: 'supabase-migration-funnel-pages-checkout-mode.sql',
};

/** The optional column this error is complaining about, if any. */
function missingOptionalColumn<T extends Record<string, unknown>>(
  err: unknown,
  payload: T,
): string | null {
  for (const column of OPTIONAL_FUNNEL_PAGE_COLUMNS) {
    if (column in payload && isMissingColumnError(err, column)) return column;
  }
  return null;
}

function withoutColumn<T extends Record<string, unknown>>(payload: T, column: string): T {
  const rest = { ...payload };
  delete rest[column];
  return rest;
}

// True when the supabase error is a "column does not exist" failure for the
// given column name. Used to retry without optional new columns whose
// migration may not have been applied yet (e.g. `angle`).
function isMissingColumnError(err: unknown, column: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { message?: unknown }).message || '').toLowerCase();
  // PostgREST surfaces the underlying Postgres "column ... does not exist"
  // text. Match both the Postgres wording and the field name appearing in
  // a "could not find the X column" PostgREST message.
  return (
    (msg.includes('column') && msg.includes(column.toLowerCase()) && msg.includes('does not exist')) ||
    (msg.includes(`'${column.toLowerCase()}'`) && msg.includes('column'))
  );
}

export async function createFunnelPage(page: FunnelPageInsert): Promise<FunnelPage> {
  const requested = sanitizePageTypeForDb(page.page_type);
  const safePage: FunnelPageInsert = {
    ...sanitizeFunnelPagePayload(page),
    page_type: requested,
  };

  let { data, error } = await supabase
    .from('funnel_pages')
    .insert(safePage)
    .select()
    .single();

  // Retry without any optional column whose migration hasn't been applied
  // yet. The rest of the row still gets created so the user isn't blocked.
  // Loops because a deploy can be behind on more than one migration.
  let insertPayload = safePage as FunnelPageInsert & Record<string, unknown>;
  for (let i = 0; i < OPTIONAL_FUNNEL_PAGE_COLUMNS.length && error; i++) {
    const column = missingOptionalColumn(error, insertPayload);
    if (!column) break;
    console.warn(
      `[funnel_pages] \`${column}\` column missing — run ${OPTIONAL_COLUMN_MIGRATION[column]} to enable persistence`,
    );
    insertPayload = withoutColumn(insertPayload, column);
    const retry = await supabase
      .from('funnel_pages')
      .insert(insertPayload)
      .select()
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error && isPageTypeEnumError(error)) {
    const fallback = legacyEnumPageType(requested);
    console.warn(
      `[funnel_pages] enum rejected page_type="${requested}" — retrying as "${fallback}". Run supabase-migration-page-type-text.sql`,
    );
    insertPayload = { ...insertPayload, page_type: fallback };
    const retry = await supabase
      .from('funnel_pages')
      .insert(insertPayload)
      .select()
      .single();
    data = retry.data;
    error = retry.error;
    if (!error && data) {
      return withRequestedPageType(data, requested);
    }
  }

  if (error) {
    console.error('Error creating funnel page:', error, '\nOriginal page_type:', page.page_type, '→ sanitized:', safePage.page_type);
    throw error;
  }
  return data!;
}

export async function updateFunnelPage(id: string, updates: FunnelPageUpdate): Promise<FunnelPage> {
  const requested =
    updates.page_type !== undefined ? sanitizePageTypeForDb(updates.page_type) : undefined;
  const safeUpdates: FunnelPageUpdate = {
    ...sanitizeFunnelPagePayload(updates),
    ...(requested !== undefined ? { page_type: requested } : {}),
  };

  let { data, error } = await supabase
    .from('funnel_pages')
    .update(safeUpdates)
    .eq('id', id)
    .select()
    .single();

  let updatePayload = safeUpdates as FunnelPageUpdate & Record<string, unknown>;
  for (let i = 0; i < OPTIONAL_FUNNEL_PAGE_COLUMNS.length && error; i++) {
    const column = missingOptionalColumn(error, updatePayload);
    if (!column) break;
    console.warn(
      `[funnel_pages] \`${column}\` column missing — run ${OPTIONAL_COLUMN_MIGRATION[column]} to enable persistence`,
    );
    updatePayload = withoutColumn(updatePayload, column);
    const retry = await supabase
      .from('funnel_pages')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error && requested !== undefined && isPageTypeEnumError(error)) {
    const fallback = legacyEnumPageType(requested);
    console.warn(
      `[funnel_pages] enum rejected page_type="${requested}" — retrying as "${fallback}". Run supabase-migration-page-type-text.sql`,
    );
    updatePayload = { ...updatePayload, page_type: fallback };
    const retry = await supabase
      .from('funnel_pages')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();
    data = retry.data;
    error = retry.error;
    if (!error && data) {
      return withRequestedPageType(data, requested);
    }
  }

  if (error) {
    console.error('Error updating funnel page:', error);
    throw error;
  }
  return requested !== undefined && data
    ? withRequestedPageType(data, requested)
    : data!;
}

export async function deleteFunnelPage(id: string): Promise<void> {
  const { error } = await supabase
    .from('funnel_pages')
    .delete()
    .eq('id', id);
  
  if (error) {
    console.error('Error deleting funnel page:', error);
    throw error;
  }
}

// =====================================================
// POST PURCHASE PAGES OPERATIONS
// =====================================================

export async function fetchPostPurchasePages(): Promise<PostPurchasePage[]> {
  const { data, error } = await supabase
    .from('post_purchase_pages')
    .select('*')
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching post purchase pages:', error);
    throw error;
  }
  return data || [];
}

export async function createPostPurchasePage(page: PostPurchasePageInsert): Promise<PostPurchasePage> {
  const { data, error } = await supabase
    .from('post_purchase_pages')
    .insert(page)
    .select()
    .single();
  
  if (error) {
    console.error('Error creating post purchase page:', error);
    throw error;
  }
  return data;
}

export async function updatePostPurchasePage(id: string, updates: PostPurchasePageUpdate): Promise<PostPurchasePage> {
  const { data, error } = await supabase
    .from('post_purchase_pages')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  
  if (error) {
    console.error('Error updating post purchase page:', error);
    throw error;
  }
  return data;
}

export async function deletePostPurchasePage(id: string): Promise<void> {
  const { error } = await supabase
    .from('post_purchase_pages')
    .delete()
    .eq('id', id);
  
  if (error) {
    console.error('Error deleting post purchase page:', error);
    throw error;
  }
}

// =====================================================
// FUNNEL CRAWL STEPS (Funnel Analyzer - step storage)
// =====================================================

/** Vision AI analysis to save per step (stepIndex -> analysis) */
export type VisionAnalysisMap = Record<number, Record<string, unknown>>;

export async function createFunnelCrawlSteps(
  entryUrl: string,
  funnelName: string,
  funnelTag: string | null,
  steps: Array<{
    stepIndex: number;
    url: string;
    title: string;
    links: unknown;
    ctaButtons: unknown;
    forms: unknown;
    networkRequests: unknown;
    cookies: unknown;
    domLength: number;
    redirectFrom?: string;
    timestamp: string;
    screenshotBase64?: string;
    isQuizStep?: boolean;
    quizStepLabel?: string;
  }>,
  visionAnalysesByStep?: VisionAnalysisMap
): Promise<{ count: number; ids: string[] }> {
  const rows: FunnelCrawlStepInsert[] = steps.map((s) => ({
    funnel_name: funnelName.trim() || 'Unnamed',
    funnel_tag: funnelTag?.trim() || null,
    entry_url: entryUrl,
    step_index: s.stepIndex,
    url: s.url,
    title: s.title || '',
    step_data: {
      links: s.links,
      ctaButtons: s.ctaButtons,
      forms: s.forms,
      networkRequests: s.networkRequests,
      cookies: s.cookies,
      domLength: s.domLength,
      redirectFrom: s.redirectFrom,
      timestamp: s.timestamp,
      isQuizStep: s.isQuizStep,
      quizStepLabel: s.quizStepLabel,
    } as unknown as Json,
    screenshot_base64: s.screenshotBase64 ?? null,
    vision_analysis: (visionAnalysesByStep?.[s.stepIndex] ?? null) as unknown as Json,
  }));

  const { data, error } = await supabase
    .from('funnel_crawl_steps')
    .insert(rows)
    .select('id');

  if (error) {
    console.error('Error creating funnel crawl steps:', error);
    throw error;
  }
  return { count: data?.length ?? 0, ids: (data ?? []).map((r) => r.id) };
}

export async function fetchFunnelCrawlSteps(): Promise<FunnelCrawlStepRow[]> {
  const { data, error } = await supabase
    .from('funnel_crawl_steps')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Error fetching funnel crawl steps:', error);
    throw error;
  }
  return data ?? [];
}

export async function fetchFunnelCrawlStepsByFunnel(
  entryUrl: string,
  funnelName: string
): Promise<FunnelCrawlStepRow[]> {
  const { data, error } = await supabase
    .from('funnel_crawl_steps')
    .select('*')
    .eq('entry_url', entryUrl)
    .eq('funnel_name', funnelName)
    .order('step_index', { ascending: true });
  if (error) {
    console.error('Error fetching funnel crawl steps by funnel:', error);
    throw error;
  }
  return data ?? [];
}

export async function deleteFunnelCrawlStepsByFunnel(entryUrl: string, funnelName: string): Promise<void> {
  const { error } = await supabase
    .from('funnel_crawl_steps')
    .delete()
    .eq('entry_url', entryUrl)
    .eq('funnel_name', funnelName);
  if (error) {
    console.error('Error deleting funnel crawl steps:', error);
    throw error;
  }
}

// =====================================================
// VISION ANALYSIS (update existing steps with AI analysis)
// =====================================================

export async function updateFunnelCrawlStepsVision(
  entryUrl: string,
  funnelName: string,
  visionAnalyses: Array<{ stepIndex: number; analysis: Record<string, unknown> }>
): Promise<{ updated: number }> {
  if (visionAnalyses.length === 0) return { updated: 0 };
  let updated = 0;
  for (const { stepIndex, analysis } of visionAnalyses) {
    const { error } = await supabase
      .from('funnel_crawl_steps')
      .update({ vision_analysis: analysis })
      .eq('entry_url', entryUrl)
      .eq('funnel_name', funnelName)
      .eq('step_index', stepIndex);
    if (!error) updated += 1;
    if (error) console.error('Error updating vision for step', stepIndex, error);
  }
  return { updated };
}

// =====================================================
// AFFILIATE BROWSER CHATS (save prompts and results)
// =====================================================

export async function createAffiliateBrowserChat(
  chat: AffiliateBrowserChatInsert
): Promise<AffiliateBrowserChat> {
  const { data, error } = await supabase
    .from('affiliate_browser_chats')
    .insert(chat)
    .select()
    .single();

  if (error) {
    console.error('Error creating affiliate browser chat:', error);
    throw error;
  }
  return data;
}

export async function updateAffiliateBrowserChat(
  id: string,
  updates: AffiliateBrowserChatUpdate
): Promise<AffiliateBrowserChat> {
  const { data, error } = await supabase
    .from('affiliate_browser_chats')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating affiliate browser chat:', error);
    throw error;
  }
  return data;
}

export async function updateAffiliateBrowserChatByJobId(
  jobId: string,
  updates: AffiliateBrowserChatUpdate
): Promise<AffiliateBrowserChat | null> {
  const { data, error } = await supabase
    .from('affiliate_browser_chats')
    .update(updates)
    .eq('job_id', jobId)
    .select()
    .single();

  if (error) {
    console.error('Error updating affiliate browser chat by job_id:', error);
    return null;
  }
  return data;
}

export async function fetchAffiliateBrowserChats(): Promise<AffiliateBrowserChat[]> {
  const { data, error } = await supabase
    .from('affiliate_browser_chats')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching affiliate browser chats:', error);
    throw error;
  }
  return data ?? [];
}

export async function fetchAffiliateBrowserChatByJobId(
  jobId: string
): Promise<AffiliateBrowserChat | null> {
  const { data, error } = await supabase
    .from('affiliate_browser_chats')
    .select('*')
    .eq('job_id', jobId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    console.error('Error fetching affiliate browser chat by job_id:', error);
    return null;
  }
  return data;
}

// =====================================================
// AFFILIATE SAVED FUNNELS (structured funnels from Claude)
// =====================================================

export async function createAffiliateSavedFunnel(
  funnel: AffiliateSavedFunnelInsert
): Promise<AffiliateSavedFunnel> {
  const { data, error } = await supabase
    .from('affiliate_saved_funnels')
    .insert(funnel)
    .select()
    .single();

  if (error) {
    console.error('Error creating affiliate saved funnel:', error);
    throw error;
  }
  return data;
}

export async function fetchAffiliateSavedFunnels(): Promise<AffiliateSavedFunnel[]> {
  const { data, error } = await supabase
    .from('affiliate_saved_funnels')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching affiliate saved funnels:', error);
    throw error;
  }
  return data ?? [];
}

export async function fetchAffiliateSavedFunnelsByType(
  funnelType: string
): Promise<AffiliateSavedFunnel[]> {
  const { data, error } = await supabase
    .from('affiliate_saved_funnels')
    .select('*')
    .eq('funnel_type', funnelType)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching affiliate saved funnels by type:', error);
    throw error;
  }
  return data ?? [];
}

export async function deleteAffiliateSavedFunnel(id: string): Promise<void> {
  const { error } = await supabase
    .from('affiliate_saved_funnels')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('Error deleting affiliate saved funnel:', error);
    throw error;
  }
}

// =====================================================
// SCHEDULED BROWSER JOBS (schedulable jobs)
// =====================================================

export async function createScheduledBrowserJob(
  job: ScheduledBrowserJobInsert
): Promise<ScheduledBrowserJob> {
  const { data, error } = await supabase
    .from('scheduled_browser_jobs')
    .insert(job)
    .select()
    .single();

  if (error) {
    console.error('Error creating scheduled browser job:', error);
    throw error;
  }
  return data;
}

export async function fetchScheduledBrowserJobs(): Promise<ScheduledBrowserJob[]> {
  const { data, error } = await supabase
    .from('scheduled_browser_jobs')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching scheduled browser jobs:', error);
    throw error;
  }
  return data ?? [];
}

export async function fetchActiveScheduledJobs(): Promise<ScheduledBrowserJob[]> {
  const { data, error } = await supabase
    .from('scheduled_browser_jobs')
    .select('*')
    .eq('is_active', true)
    .order('next_run_at', { ascending: true });

  if (error) {
    console.error('Error fetching active scheduled jobs:', error);
    throw error;
  }
  return data ?? [];
}

export async function fetchDueScheduledJobs(): Promise<ScheduledBrowserJob[]> {
  const { data, error } = await supabase
    .from('scheduled_browser_jobs')
    .select('*')
    .eq('is_active', true)
    .lte('next_run_at', new Date().toISOString())
    .order('next_run_at', { ascending: true });

  if (error) {
    console.error('Error fetching due scheduled jobs:', error);
    throw error;
  }
  return data ?? [];
}

export async function updateScheduledBrowserJob(
  id: string,
  updates: ScheduledBrowserJobUpdate
): Promise<ScheduledBrowserJob> {
  const { data, error } = await supabase
    .from('scheduled_browser_jobs')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating scheduled browser job:', error);
    throw error;
  }
  return data;
}

export async function deleteScheduledBrowserJob(id: string): Promise<void> {
  const { error } = await supabase
    .from('scheduled_browser_jobs')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('Error deleting scheduled browser job:', error);
    throw error;
  }
}

export async function toggleScheduledBrowserJob(id: string, isActive: boolean): Promise<ScheduledBrowserJob> {
  return updateScheduledBrowserJob(id, { is_active: isActive });
}

// =====================================================
// SAVED PROMPTS OPERATIONS
// =====================================================

export async function fetchSavedPrompts(): Promise<SavedPrompt[]> {
  const { data, error } = await supabase
    .from('saved_prompts')
    .select('*')
    .order('is_favorite', { ascending: false })
    .order('use_count', { ascending: false })
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching saved prompts:', error);
    throw error;
  }
  return data || [];
}

export async function fetchSavedPromptsByCategory(category: string): Promise<SavedPrompt[]> {
  const { data, error } = await supabase
    .from('saved_prompts')
    .select('*')
    .eq('category', category)
    .order('is_favorite', { ascending: false })
    .order('use_count', { ascending: false });
  
  if (error) {
    console.error('Error fetching saved prompts by category:', error);
    throw error;
  }
  return data || [];
}

export async function createSavedPrompt(prompt: SavedPromptInsert): Promise<SavedPrompt> {
  const { data, error } = await supabase
    .from('saved_prompts')
    .insert(prompt)
    .select()
    .single();
  
  if (error) {
    console.error('Error creating saved prompt:', error);
    throw error;
  }
  return data;
}

export async function updateSavedPrompt(id: string, updates: SavedPromptUpdate): Promise<SavedPrompt> {
  const { data, error } = await supabase
    .from('saved_prompts')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  
  if (error) {
    console.error('Error updating saved prompt:', error);
    throw error;
  }
  return data;
}

export async function deleteSavedPrompt(id: string): Promise<void> {
  const { error } = await supabase
    .from('saved_prompts')
    .delete()
    .eq('id', id);
  
  if (error) {
    console.error('Error deleting saved prompt:', error);
    throw error;
  }
}

export async function incrementPromptUseCount(id: string): Promise<void> {
  const { data: current } = await supabase
    .from('saved_prompts')
    .select('use_count')
    .eq('id', id)
    .single();

  await supabase
    .from('saved_prompts')
    .update({ use_count: (current?.use_count || 0) + 1 })
    .eq('id', id);
}

// =====================================================
// ARCHIVED FUNNELS
// =====================================================

export async function fetchArchivedFunnels(): Promise<ArchivedFunnel[]> {
  const { data, error } = await supabase
    .from('archived_funnels')
    .select('*')
    .is('project_id', null)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching archived funnels:', error);
    throw error;
  }
  return data;
}

export async function createArchivedFunnel(funnel: ArchivedFunnelInsert): Promise<ArchivedFunnel> {
  const { data, error } = await supabase
    .from('archived_funnels')
    .insert(funnel)
    .select()
    .single();

  if (error) {
    console.error('Error creating archived funnel:', error);
    throw error;
  }
  return data;
}

export async function updateArchivedFunnel(id: string, updates: ArchivedFunnelUpdate): Promise<ArchivedFunnel> {
  const { data, error } = await supabase
    .from('archived_funnels')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating archived funnel:', error);
    throw error;
  }
  return data;
}

export async function deleteArchivedFunnel(id: string): Promise<void> {
  const { error } = await supabase
    .from('archived_funnels')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('Error deleting archived funnel:', error);
    throw error;
  }
}

/** Calculate the next next_run_at based on frequency */
export function calculateNextRunAt(frequency: string, fromDate?: Date): string {
  const now = fromDate || new Date();
  const next = new Date(now);

  switch (frequency) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'bi_weekly':
      next.setDate(next.getDate() + 14);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
    default:
      next.setDate(next.getDate() + 1);
  }

  next.setHours(6, 0, 0, 0);
  return next.toISOString();
}
