import { supabase } from './supabase';
import type {
  Product,
  ProductInsert,
  ProductUpdate,
  SwipeTemplate,
  SwipeTemplateInsert,
  SwipeTemplateUpdate,
  FunnelPage,
  FunnelPageInsert,
  FunnelPageUpdate,
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
// SWIPE TEMPLATES OPERATIONS
// =====================================================

export async function fetchTemplates(): Promise<SwipeTemplate[]> {
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
  const { data, error } = await supabase
    .from('swipe_templates')
    .insert(template)
    .select()
    .single();
  
  if (error) {
    console.error('Error creating template:', error);
    throw error;
  }
  return data;
}

export async function updateTemplate(id: string, updates: SwipeTemplateUpdate): Promise<SwipeTemplate> {
  const { data, error } = await supabase
    .from('swipe_templates')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  
  if (error) {
    console.error('Error updating template:', error);
    throw error;
  }
  return data;
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
  const { data, error } = await supabase
    .from('funnel_pages')
    .select('*')
    .order('created_at', { ascending: true }); // oldest first = Step 1 at top
  
  if (error) {
    console.error('Error fetching funnel pages:', error);
    throw error;
  }
  return data || [];
}

export async function createFunnelPage(page: FunnelPageInsert): Promise<FunnelPage> {
  const { data, error } = await supabase
    .from('funnel_pages')
    .insert(page)
    .select()
    .single();
  
  if (error) {
    console.error('Error creating funnel page:', error);
    throw error;
  }
  return data;
}

export async function updateFunnelPage(id: string, updates: FunnelPageUpdate): Promise<FunnelPage> {
  const { data, error } = await supabase
    .from('funnel_pages')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  
  if (error) {
    console.error('Error updating funnel page:', error);
    throw error;
  }
  return data;
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
    vision_analysis: visionAnalysesByStep?.[s.stepIndex] ?? null,
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
