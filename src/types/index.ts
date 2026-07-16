export type TemplateType = 
  | 'advertorial' 
  | 'checkout' 
  | 'oto_1' 
  | 'oto_2' 
  | 'upsell' 
  | 'downsell';

// Built-in page types
export type BuiltInPageType = 
  // Pre-sell / Top of Funnel
  | 'advertorial'
  | 'listicle'
  | '5_reasons_listicle'
  | 'native_ad'
  | 'vsl'
  | 'webinar'
  | 'bridge_page'
  // Landing & Opt-in
  | 'landing'
  | 'opt_in'
  | 'squeeze_page'
  | 'lead_magnet'
  // Quiz & Survey
  | 'quiz_funnel'
  | 'survey'
  | 'assessment'
  // Sales Pages
  | 'sales_letter'
  | 'product_page'
  | 'offer_page'
  | 'checkout'
  // Post-Purchase
  | 'thank_you'
  | 'upsell'
  | 'downsell'
  | 'oto'
  | 'order_confirmation'
  | 'membership'
  // Content Pages
  | 'blog'
  | 'article'
  | 'content_page'
  | 'review'
  // Compliance & Safe
  | 'safe_page'
  | 'privacy'
  | 'terms'
  | 'disclaimer'
  // Other
  | 'other';

// PageType can be a built-in type OR a custom string
export type PageType = BuiltInPageType | string;

export type SwipeStatus = 
  | 'pending' 
  | 'in_progress' 
  | 'completed' 
  | 'failed';

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  imageUrl?: string;
  benefits: string[];
  ctaText: string;
  ctaUrl: string;
  brandName: string;
  sku?: string;
  category?: string;
  characteristics?: string[];
  geoMarket?: string;
  supplier?: string;
  createdAt: Date;
}

export interface SwipeApiResponse {
  success: boolean;
  original_url: string;
  original_title: string;
  new_title: string;
  html: string;
  changes_made: string[];
  original_length: number;
  new_length: number;
  processing_time_seconds: number;
  method_used: string;
  error: string | null;
  warnings: string[];
}

export interface SwipedPageData {
  html: string;
  mobileHtml?: string;
  originalTitle: string;
  newTitle: string;
  originalLength: number;
  newLength: number;
  processingTime: number;
  methodUsed: string;
  changesMade: string[];
  swipedAt: Date;
  /** Vedi ClonedPageData per la semantica di questi campi. */
  jobId?: string;
  htmlSkipped?: boolean;
  htmlLength?: number;
  mobileHtmlSkipped?: boolean;
  mobileHtmlLength?: number;
  htmlUrl?: string;
  mobileHtmlUrl?: string;
}

export interface FunnelAnalysis {
  headline: string;
  subheadline: string;
  cta: string[];
  price: string | null;
  benefits: string[];
}

export type TemplateCategory = 'standard' | 'quiz';

export type TemplateViewFormat = 'desktop' | 'mobile';

export interface SwipeTemplate {
  id: string;
  name: string;
  sourceUrl: string;
  pageType: PageType;
  category: TemplateCategory;
  viewFormat: TemplateViewFormat;
  tags: string[];
  description?: string;
  previewImage?: string;
  createdAt: Date;
}

export const TEMPLATE_VIEW_FORMAT_OPTIONS: { value: TemplateViewFormat; label: string; icon: string }[] = [
  { value: 'desktop', label: 'Desktop', icon: '🖥️' },
  { value: 'mobile', label: 'Mobile', icon: '📱' },
];

export const TEMPLATE_CATEGORY_OPTIONS: { value: TemplateCategory; label: string; description: string }[] = [
  { value: 'standard', label: 'Standard Template', description: 'Landing page, advertorial, checkout, etc.' },
  { value: 'quiz', label: 'Quiz Template', description: 'Quiz funnels, surveys, interactive lead magnets' },
];

/** Template library — Phase 1: save, categorize and organize funnels of different types */
export interface LibraryTemplateEntry {
  id: string;
  name: string;
  category: TemplateCategory;
}

export const LIBRARY_TEMPLATES: LibraryTemplateEntry[] = [
  { id: 'quiz-mounjaro-fit', name: 'Quiz funnel Mounjaro Fit', category: 'quiz' },
  { id: 'funnel-bioma', name: 'Funnel Bioma', category: 'standard' },
  { id: 'funnel-cold-protector', name: 'Funnel Cold Protector', category: 'standard' },
  { id: 'funnel-rosabella', name: 'Funnel Rosabella', category: 'standard' },
];

export type QuizAnalysisStatus = 'pending' | 'analyzing' | 'completed' | 'failed';

export interface QuizAnalysisResult {
  totalQuestions: number;
  questionTypes: string[];
  flowStructure: string;
  resultsLogic: string;
  designPatterns: string[];
  ctaElements: string[];
  engagementTechniques: string[];
  recommendations: string[];
  rawAnalysis: string;
  analyzedAt: Date;
}

export interface QuizTemplate {
  id: string;
  name: string;
  sourceUrl: string;
  description?: string;
  tags: string[];
  analysisStatus: QuizAnalysisStatus;
  analysisResult?: QuizAnalysisResult;
  createdAt: Date;
}

export interface ClonedPageData {
  html: string;
  mobileHtml?: string;
  title: string;
  method_used: string;
  content_length: number;
  duration_seconds: number;
  cloned_at: Date;
  /** Job id quando l'HTML arriva da un worker (rewrite / extract). */
  jobId?: string;
  /** Set dallo strip server-side: il blob HTML è stato tolto dal JSONB
   *  per non triggerare Postgres 57014 (statement_timeout 3s).
   *  L'HTML è recuperabile via htmlUrl (Supabase Storage), openclaw_messages
   *  (se jobId presente) o IndexedDB locale. Vedi useStore rehydrate logic. */
  htmlSkipped?: boolean;
  htmlLength?: number;
  mobileHtmlSkipped?: boolean;
  mobileHtmlLength?: number;
  /** URL pubblico Supabase Storage da cui recuperare l'HTML al boot.
   *  Scritto da supabaseOps.updateFunnelPage quando l'html supera la
   *  soglia di persistenza JSONB (50 KB). Persiste cross-browser e
   *  cross-device — IndexedDB resta solo come backup locale. */
  htmlUrl?: string;
  mobileHtmlUrl?: string;
}

export interface FunnelPage {
  id: string;
  name: string;
  pageType: PageType;
  templateId?: string; // Reference to SwipeTemplate
  productId: string;
  urlToSwipe: string;
  angle?: string; // Marketing angle for this step (e.g. "fear-of-loss", "social proof")
  prompt?: string; // Custom prompt for AI analysis
  swipeStatus: SwipeStatus;
  swipeResult?: string;
  feedback?: string; // User feedback after swipe
  clonedData?: ClonedPageData;
  swipedData?: SwipedPageData;
  analysisStatus?: SwipeStatus;
  analysisResult?: string;
  extractedData?: FunnelAnalysis;
  createdAt: Date;
  updatedAt: Date;
}

export interface PostPurchasePage {
  id: string;
  name: string;
  type: 'thank_you' | 'upsell_1' | 'upsell_2' | 'downsell' | 'order_confirmation';
  productId: string;
  urlToSwipe: string;
  swipeStatus: SwipeStatus;
  swipeResult?: string;
  clonedData?: ClonedPageData;
  swipedData?: SwipedPageData;
  createdAt: Date;
  updatedAt: Date;
}

export const TEMPLATE_OPTIONS: { value: TemplateType; label: string }[] = [
  { value: 'advertorial', label: 'Advertorial' },
  { value: 'checkout', label: 'Checkout' },
  { value: 'oto_1', label: 'OTO 1' },
  { value: 'oto_2', label: 'OTO 2' },
  { value: 'upsell', label: 'Upsell' },
  { value: 'downsell', label: 'Downsell' },
];

// Custom page type created by user
export interface CustomPageType {
  id: string;
  value: string;
  label: string;
  category: 'custom';
  createdAt: Date;
}

// Page type option with category grouping
export interface PageTypeOption {
  value: PageType;
  label: string;
  category: 'presell' | 'landing' | 'quiz' | 'sales' | 'postpurchase' | 'content' | 'compliance' | 'other' | 'custom';
}

// Built-in page type options — the canonical archive taxonomy ("By Type").
// Keep this list tight and meaningful: it drives the extension's Type
// dropdown, the app's type selectors, and the folder labels in My Archive.
export const BUILT_IN_PAGE_TYPE_OPTIONS: PageTypeOption[] = [
  { value: 'landing', label: 'Landing Page', category: 'landing' },
  { value: 'bridge_page', label: 'Bridge Page', category: 'presell' },
  { value: 'advertorial', label: 'Advertorial', category: 'presell' },
  { value: 'lst', label: 'LST', category: 'sales' },
  { value: 'vsl', label: 'VSL', category: 'sales' },
  { value: 'tsl', label: 'TSL', category: 'sales' },
  { value: 'quiz', label: 'Quiz', category: 'quiz' },
  { value: 'product_page', label: 'Product Page', category: 'sales' },
  { value: 'checkout', label: 'Checkout', category: 'sales' },
  { value: 'thank_you', label: 'Thank Page', category: 'postpurchase' },
  { value: 'upsell_1', label: 'Upsell 1', category: 'postpurchase' },
  { value: 'upsell_2', label: 'Upsell 2', category: 'postpurchase' },
  { value: 'upsell_3', label: 'Upsell 3', category: 'postpurchase' },
  { value: 'downsell_1', label: 'Downsell 1', category: 'postpurchase' },
  { value: 'downsell_2', label: 'Downsell 2', category: 'postpurchase' },
  { value: 'downsell_3', label: 'Downsell 3', category: 'postpurchase' },
];

// Category labels for grouping in UI
export const PAGE_TYPE_CATEGORIES: { value: PageTypeOption['category']; label: string; color: string }[] = [
  { value: 'presell', label: 'Pre-Sell / Top of Funnel', color: 'bg-orange-100 text-orange-800' },
  { value: 'landing', label: 'Landing & Opt-in', color: 'bg-blue-100 text-blue-800' },
  { value: 'quiz', label: 'Quiz & Survey', color: 'bg-purple-100 text-purple-800' },
  { value: 'sales', label: 'Sales Pages', color: 'bg-green-100 text-green-800' },
  { value: 'postpurchase', label: 'Post-Purchase', color: 'bg-yellow-100 text-yellow-800' },
  { value: 'content', label: 'Content Pages', color: 'bg-gray-100 text-gray-800' },
  { value: 'compliance', label: 'Compliance & Safe', color: 'bg-red-100 text-red-800' },
  { value: 'other', label: 'Other', color: 'bg-gray-100 text-gray-600' },
  { value: 'custom', label: 'Custom Categories', color: 'bg-indigo-100 text-indigo-800' },
];

// Legacy simple format for backward compatibility
export const PAGE_TYPE_OPTIONS: { value: PageType; label: string }[] = BUILT_IN_PAGE_TYPE_OPTIONS.map(opt => ({
  value: opt.value,
  label: opt.label,
}));

// Maps any legacy / messy `page_type` string to one of the canonical codes
// above, so the archive "By Type" collapses duplicate + nonsensical folders
// (e.g. "Checkout", "Checkout Page", "checkout" → one "Checkout"). Anything
// unrecognized falls into the residual "altro" bucket instead of spawning its
// own folder. Pure display-time normalization — does not mutate stored data.
const PAGE_TYPE_SYNONYMS: Record<string, string> = {
  landing: 'landing', 'landing page': 'landing', landing_page: 'landing',
  opt_in: 'landing', 'opt-in': 'landing', optin: 'landing',
  squeeze: 'landing', squeeze_page: 'landing', lead_magnet: 'landing',
  home: 'landing', homepage: 'landing', info_screen: 'landing',
  bridge: 'bridge_page', bridge_page: 'bridge_page', 'bridge page': 'bridge_page',
  advertorial: 'advertorial', 'advertorial / pre-sell': 'advertorial',
  'advertorial pre-sell': 'advertorial', presell: 'advertorial', 'pre-sell': 'advertorial',
  listicle: 'advertorial', '5_reasons_listicle': 'advertorial', native_ad: 'advertorial',
  'native ad': 'advertorial', ads: 'advertorial', ad: 'advertorial',
  review: 'advertorial', article: 'advertorial', blog: 'advertorial', content_page: 'advertorial',
  lst: 'lst', long_sales_text: 'lst', 'long sales text': 'lst',
  vsl: 'vsl', video_sales_letter: 'vsl', webinar: 'vsl',
  tsl: 'tsl', text_sales_letter: 'tsl', sales_letter: 'tsl', 'sales letter': 'tsl',
  quiz: 'quiz', quiz_funnel: 'quiz', survey: 'quiz', assessment: 'quiz',
  product_page: 'product_page', 'product page': 'product_page', offer_page: 'product_page', offer: 'product_page',
  checkout: 'checkout', 'checkout page': 'checkout', checkout_page: 'checkout', order: 'checkout',
  thank_you: 'thank_you', 'thank you': 'thank_you', 'thank you page': 'thank_you',
  thankpage: 'thank_you', 'thank page': 'thank_you', order_confirmation: 'thank_you', 'order confirmation': 'thank_you',
  upsell: 'upsell_1', upsell_1: 'upsell_1', 'upsell 1': 'upsell_1', upsell1: 'upsell_1', oto: 'upsell_1', oto_1: 'upsell_1',
  upsell_2: 'upsell_2', 'upsell 2': 'upsell_2', upsell2: 'upsell_2', oto_2: 'upsell_2',
  upsell_3: 'upsell_3', 'upsell 3': 'upsell_3', upsell3: 'upsell_3', oto_3: 'upsell_3',
  downsell: 'downsell_1', downsell_1: 'downsell_1', 'downsell 1': 'downsell_1',
  downsell1: 'downsell_1', 'downsell page': 'downsell_1',
  downsell_2: 'downsell_2', 'downsell 2': 'downsell_2', downsell2: 'downsell_2',
  downsell_3: 'downsell_3', 'downsell 3': 'downsell_3', downsell3: 'downsell_3',
};

export function normalizeArchiveType(raw: string | null | undefined): string {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return 'altro';
  return PAGE_TYPE_SYNONYMS[key] || 'altro';
}

export const POST_PURCHASE_TYPE_OPTIONS: { value: PostPurchasePage['type']; label: string }[] = [
  { value: 'thank_you', label: 'Thank You Page' },
  { value: 'upsell_1', label: 'Upsell 1' },
  { value: 'upsell_2', label: 'Upsell 2' },
  { value: 'downsell', label: 'Downsell' },
  { value: 'order_confirmation', label: 'Order Confirmation' },
];

export const STATUS_OPTIONS: { value: SwipeStatus; label: string; color: string }[] = [
  { value: 'pending', label: 'Pending', color: 'bg-gray-200 text-gray-800' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-yellow-200 text-yellow-800' },
  { value: 'completed', label: 'Completed', color: 'bg-green-200 text-green-800' },
  { value: 'failed', label: 'Failed', color: 'bg-red-200 text-red-800' },
];

// =====================================================
// VISION ANALYSIS TYPES
// =====================================================

export interface VisionSection {
  section_index: number;
  section_type_hint: string;
  confidence: number;
  text_preview: string;
  has_cta: boolean;
  bounding_box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface VisionImage {
  image_type: string;
  description: string;
  suggestion: string;
  src?: string;
  alt?: string;
}

export interface VisionJobSummary {
  id: string;
  source_url: string;
  screenshot_url?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  total_sections_detected: number;
  created_at: string;
  completed_at?: string;
  error?: string;
}

export interface VisionJobDetail extends VisionJobSummary {
  sections: VisionSection[];
  images: VisionImage[];
  page_structure?: {
    has_hero: boolean;
    has_testimonials: boolean;
    has_pricing: boolean;
    has_faq: boolean;
    has_footer: boolean;
    estimated_scroll_depth: number;
  };
  recommendations?: string[];
  raw_analysis?: string;
}

export const SECTION_TYPE_COLORS: Record<string, string> = {
  hero: 'bg-purple-100 text-purple-800 border-purple-300',
  features: 'bg-blue-100 text-blue-800 border-blue-300',
  benefits: 'bg-green-100 text-green-800 border-green-300',
  testimonials: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  pricing: 'bg-orange-100 text-orange-800 border-orange-300',
  cta: 'bg-red-100 text-red-800 border-red-300',
  faq: 'bg-indigo-100 text-indigo-800 border-indigo-300',
  footer: 'bg-gray-100 text-gray-800 border-gray-300',
  header: 'bg-teal-100 text-teal-800 border-teal-300',
  social_proof: 'bg-pink-100 text-pink-800 border-pink-300',
  unknown: 'bg-gray-100 text-gray-600 border-gray-300',
};

// =====================================================
// FUNNEL ANALYZER (Browser automation / crawl)
// =====================================================

export interface FunnelCrawlLink {
  href: string;
  text: string;
  isCta: boolean;
  selector?: string;
}

export interface FunnelCrawlForm {
  action: string;
  method: string;
  inputs: { name: string; type: string; required?: boolean }[];
  submitButtonText?: string;
}

export interface FunnelCrawlNetworkRequest {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  isTracking?: boolean;
  isCheckout?: boolean;
}

export interface FunnelCrawlCookie {
  name: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface FunnelCrawlStep {
  stepIndex: number;
  url: string;
  title: string;
  screenshotBase64?: string;
  links: FunnelCrawlLink[];
  ctaButtons: FunnelCrawlLink[];
  forms: FunnelCrawlForm[];
  networkRequests: FunnelCrawlNetworkRequest[];
  cookies: FunnelCrawlCookie[];
  domLength: number;
  redirectFrom?: string;
  timestamp: string;
  /** True when step comes from quiz mode (same URL, content changed via JS) */
  isQuizStep?: boolean;
  /** Human-readable label for quiz step (e.g. "Step 1: How old are you?") */
  quizStepLabel?: string;
  /** Main text content (e.g. when single-page crawl for landing analyzer) */
  contentText?: string;
  /**
   * Public Supabase Storage URL of the per-step screenshot. Distinct from
   * screenshotBase64 which is inline base64. The worker uploads to
   * storage and writes the URL here; the UI prefers this over the base64
   * because it keeps the JSONB result row small.
   */
  screenshotUrl?: string | null;
  /**
   * Full post-render DOM HTML at this step. Populated only when the job
   * was enqueued with `params.captureHtml=true` (e.g. by the Clone/Swipe
   * Quiz section). Null/undefined for regular Funnel Analyzer crawls so
   * we don't bloat the result row with megabytes of HTML the UI never
   * needs.
   */
  html?: string | null;
  /** Length of `html` in chars — populated even if `html` is null. */
  htmlLength?: number;
}

export interface FunnelCrawlOptions {
  entryUrl: string;
  headless?: boolean;
  maxSteps?: number;
  maxDepth?: number;
  followSameOriginOnly?: boolean;
  captureScreenshots?: boolean;
  captureDom?: boolean;
  captureNetwork?: boolean;
  captureCookies?: boolean;
  simulateInteractions?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface FunnelCrawlResult {
  success: boolean;
  entryUrl: string;
  steps: FunnelCrawlStep[];
  totalSteps: number;
  durationMs: number;
  error?: string;
  visitedUrls: string[];
  /** True when crawl was run in quiz mode (multi-step same-URL) */
  isQuizFunnel?: boolean;
  /**
   * Why the walker stopped before reaching maxSteps (or null if it
   * walked the whole funnel cleanly). Populated by the worker so the
   * UI can show "stuck on same fingerprint", "no advance button found",
   * "checkout-like page detected", etc., without forcing the user to
   * read the worker stdout.
   */
  stopDiagnostic?: {
    reason?: string;
    atStep?: number;
    url?: string;
    title?: string;
    label?: string;
    maxSteps?: number;
    consecutiveSame?: number;
    inventory?: Array<{
      tag: string;
      cls: string;
      w: number;
      h: number;
      text: string;
      disabled: boolean;
      href: string | null;
    }>;
    hint?: string;
  } | null;
}

// =====================================================
// FUNNEL VISION ANALYSIS (AI extraction per page)
// =====================================================

export type FunnelPageType =
  | 'opt-in'
  | 'vsl'
  | 'sales_page'
  | 'order_form'
  | 'upsell'
  | 'downsell'
  | 'thank_you'
  | 'bridge_page'
  | 'landing'
  | 'checkout'
  | 'other';

// =====================================================
// AGENTIC BROWSER — Gemini Computer Use + Playwright
// =====================================================

/** Computer Use action suggested by the model */
export interface ComputerUseAction {
  name: string;
  args: Record<string, unknown>;
}

export interface AgenticCrawlStep {
  stepIndex: number;
  url: string;
  title: string;
  screenshotBase64?: string;
  /** Action(s) executed in this turn by the Computer Use model */
  actions?: ComputerUseAction[];
  /** Model reasoning/thinking text */
  modelThought?: string;
  /** Whether the action was executed successfully */
  actionExecuted?: boolean;
  /** Error in action execution */
  actionError?: string;
  /** Step timestamp */
  timestamp?: string;
}

export interface AgenticCrawlResult {
  success: boolean;
  entryUrl: string;
  steps: AgenticCrawlStep[];
  totalSteps: number;
  durationMs: number;
  error?: string;
  /** Reason why the crawl stopped */
  stopReason?: string;
}

// =====================================================
// AFFILIATE BROWSER CHAT — Remote Agentic API
// =====================================================

export type AffiliateBrowserJobStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'max_turns'
  | 'blocked'
  | 'error';

export interface AffiliateBrowserJob {
  id: string;
  status: AffiliateBrowserJobStatus;
  prompt: string;
  startUrl: string;
  maxTurns: number;
  currentTurn: number;
  turnsUsed: number;
  currentUrl: string;
  lastActions: string[];
  lastText: string;
  debugUrl: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type AffiliateChatRole = 'user' | 'agent' | 'system';

export interface AffiliateChatMessage {
  id: string;
  role: AffiliateChatRole;
  content: string;
  timestamp: Date;
  turnNumber?: number;
}

/** Statuses considered "finished" — stop polling when any of these */
export const AFFILIATE_JOB_FINISHED_STATUSES: AffiliateBrowserJobStatus[] = [
  'completed',
  'max_turns',
  'blocked',
  'error',
];

// =====================================================
// FUNNEL VISION ANALYSIS (AI extraction per page)
// =====================================================

export interface FunnelPageVisionAnalysis {
  stepIndex: number;
  url: string;
  page_type: FunnelPageType;
  headline: string | null;
  subheadline: string | null;
  body_copy: string | null;
  cta_text: string[];
  /** Main CTAs leading to the next funnel step (e.g. Buy Now, Go to checkout) */
  next_step_ctas: string[];
  offer_details: string | null;
  price_points: string[];
  urgency_elements: string[];
  social_proof: string[];
  tech_stack_detected: string[];
  outbound_links: string[];
  persuasion_techniques_used: string[];
  raw?: string;
  error?: string;
}

// =====================================================
// BRANDING GENERATOR — AI-powered branding from product + reference funnel
// =====================================================

/** Product information for branding generation */
export interface BrandingProductInput {
  name: string;
  description: string;
  price: number;
  benefits: string[];
  ctaText: string;
  ctaUrl: string;
  brandName: string;
  imageUrl?: string;
}

/** Reference funnel step with its vision analysis */
export interface BrandingReferenceFunnelStep {
  stepIndex: number;
  url: string;
  title: string;
  pageType: string;
  isQuizStep?: boolean;
  quizStepLabel?: string;
  visionAnalysis?: {
    page_type: string;
    headline: string | null;
    subheadline: string | null;
    body_copy: string | null;
    cta_text: string[];
    next_step_ctas: string[];
    offer_details: string | null;
    price_points: string[];
    urgency_elements: string[];
    social_proof: string[];
    persuasion_techniques_used: string[];
  };
}

/** Complete reference funnel (quiz or standard) from which to extract the structure */
export interface BrandingReferenceFunnel {
  funnelName: string;
  entryUrl: string;
  funnelType: string;
  steps: BrandingReferenceFunnelStep[];
  analysisSummary?: string;
  persuasionTechniques?: string[];
  leadCaptureMethod?: string;
  notableElements?: string[];
}

/** Branding generation options */
export interface BrandingGenerationOptions {
  provider?: 'claude' | 'gemini';
  tone?: 'professional' | 'casual' | 'urgent' | 'friendly' | 'luxury' | 'scientific' | 'empathetic';
  targetAudience?: string;
  niche?: string;
  language?: string;
}

/** Complete input for branding generation */
export interface BrandingGenerationInput {
  product: BrandingProductInput;
  referenceFunnel: BrandingReferenceFunnel;
  options?: BrandingGenerationOptions;
}

/** Generated color palette */
export interface BrandingColorPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  ctaBackground: string;
  ctaText: string;
}

/** Generated brand identity */
export interface BrandIdentity {
  brandName: string;
  tagline: string;
  voiceTone: string;
  emotionalHook: string;
  uniqueSellingProposition: string;
  colorPalette: BrandingColorPalette;
  typography: {
    headingStyle: string;
    bodyStyle: string;
  };
}

/** Branding content for a specific funnel step */
export interface BrandingStepContent {
  stepIndex: number;
  originalPageType: string;
  headline: string;
  subheadline: string;
  bodyCopy: string;
  ctaTexts: string[];
  nextStepCtas: string[];
  offerDetails: string | null;
  pricePresentation: string;
  urgencyElements: string[];
  socialProof: string[];
  persuasionTechniques: string[];
  quizQuestion?: string;
  quizOptions?: string[];
  quizOptionSubtexts?: string[];
}

/** Quiz funnel specific branding */
export interface QuizBranding {
  quizTitle: string;
  quizSubtitle: string;
  quizIntroText: string;
  progressBarLabel: string;
  resultPageHeadline: string;
  resultPageSubheadline: string;
  resultPageBodyCopy: string;
  personalizationHook: string;
}

/** Global branding elements (used on all pages) */
export interface BrandingGlobalElements {
  socialProofStatements: string[];
  urgencyElements: string[];
  trustBadges: string[];
  guaranteeText: string;
  disclaimerText: string;
  footerCopyright: string;
  headerText: string;
}

/** Complete output of branding generation */
export interface GeneratedBranding {
  brandIdentity: BrandIdentity;
  funnelSteps: BrandingStepContent[];
  globalElements: BrandingGlobalElements;
  quizBranding?: QuizBranding;
  swipeInstructions: string;
  metadata: {
    provider: string;
    model: string;
    generatedAt: string;
    referenceFunnelName: string;
    referenceFunnelType: string;
    productName: string;
    language: string;
    tone: string;
  };
}

export type BrandingGenerationStatus = 'idle' | 'generating' | 'completed' | 'failed';

// =====================================================
// SCHEDULED BROWSER JOBS — Automated schedulable jobs
// =====================================================

// =====================================================
// SAVED SECTIONS LIBRARY — Reusable section blocks
// =====================================================

export type OutputStack = 'pure_css' | 'bootstrap' | 'tailwind' | 'foundation' | 'bulma' | 'custom';

export const OUTPUT_STACK_OPTIONS: { value: OutputStack; label: string; description: string }[] = [
  { value: 'pure_css', label: 'Pure CSS', description: 'HTML + CSS vanilla, zero dependencies' },
  { value: 'bootstrap', label: 'Bootstrap 5', description: 'Bootstrap 5 classes + vanilla JS' },
  { value: 'tailwind', label: 'Tailwind CSS', description: 'Tailwind utility classes' },
  { value: 'foundation', label: 'Foundation 6', description: 'Foundation grid and components' },
  { value: 'bulma', label: 'Bulma', description: 'Bulma CSS-only classes' },
  { value: 'custom', label: 'Custom', description: 'Custom instructions' },
];

export interface SavedSection {
  id: string;
  name: string;
  html: string;
  /** Approximate section type (hero, testimonials, cta, etc.) */
  sectionType: string;
  tags: string[];
  /** Text preview for quick identification */
  textPreview: string;
  /** Source page URL from which the section was extracted */
  sourceUrl?: string;
  /** Source page title */
  sourcePageTitle?: string;
  /** Whether AI has rewritten the section to be standalone */
  aiRewritten: boolean;
  /** Tech stack used for the AI rewrite (bootstrap, tailwind, etc.) */
  outputStack?: OutputStack;
  createdAt: string;
  updatedAt: string;
}

export const SECTION_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'hero', label: 'Hero / Above the Fold' },
  { value: 'features', label: 'Features' },
  { value: 'benefits', label: 'Benefits' },
  { value: 'testimonials', label: 'Testimonials' },
  { value: 'social_proof', label: 'Social Proof' },
  { value: 'pricing', label: 'Pricing / Offer' },
  { value: 'cta', label: 'Call to Action' },
  { value: 'faq', label: 'FAQ' },
  { value: 'header', label: 'Header / Nav' },
  { value: 'footer', label: 'Footer' },
  { value: 'form', label: 'Form / Opt-in' },
  { value: 'video', label: 'Video Section' },
  { value: 'comparison', label: 'Comparison / Vs' },
  { value: 'guarantee', label: 'Guarantee' },
  { value: 'urgency', label: 'Urgency / Scarcity' },
  { value: 'other', label: 'Other' },
];

// =====================================================
// SCHEDULED BROWSER JOBS — Automated schedulable jobs
// =====================================================

export type ScheduledJobFrequency = 'daily' | 'weekly' | 'bi_weekly' | 'monthly';

export const SCHEDULED_JOB_FREQUENCY_OPTIONS: { value: ScheduledJobFrequency; label: string; description: string }[] = [
  { value: 'daily', label: 'Daily', description: 'Every day at 6:00 UTC' },
  { value: 'weekly', label: 'Weekly', description: 'Every 7 days' },
  { value: 'bi_weekly', label: 'Bi-weekly', description: 'Every 14 days' },
  { value: 'monthly', label: 'Monthly', description: 'Every 30 days' },
];
