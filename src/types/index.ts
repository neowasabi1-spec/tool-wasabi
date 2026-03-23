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
  originalTitle: string;
  newTitle: string;
  originalLength: number;
  newLength: number;
  processingTime: number;
  methodUsed: string;
  changesMade: string[];
  swipedAt: Date;
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
}

export interface FunnelPage {
  id: string;
  name: string;
  pageType: PageType;
  templateId?: string; // Reference to SwipeTemplate
  productId: string;
  urlToSwipe: string;
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

// Built-in page type options organized by category
export const BUILT_IN_PAGE_TYPE_OPTIONS: PageTypeOption[] = [
  // Pre-sell / Top of Funnel
  { value: 'advertorial', label: 'Advertorial', category: 'presell' },
  { value: 'listicle', label: 'Listicle', category: 'presell' },
  { value: '5_reasons_listicle', label: '5 Reasons Why Listicle', category: 'presell' },
  { value: 'native_ad', label: 'Native Ad', category: 'presell' },
  { value: 'vsl', label: 'VSL (Video Sales Letter)', category: 'presell' },
  { value: 'webinar', label: 'Webinar Page', category: 'presell' },
  { value: 'bridge_page', label: 'Bridge Page', category: 'presell' },
  // Landing & Opt-in
  { value: 'landing', label: 'Landing Page', category: 'landing' },
  { value: 'opt_in', label: 'Opt-in Page', category: 'landing' },
  { value: 'squeeze_page', label: 'Squeeze Page', category: 'landing' },
  { value: 'lead_magnet', label: 'Lead Magnet Page', category: 'landing' },
  // Quiz & Survey
  { value: 'quiz_funnel', label: 'Quiz Funnel', category: 'quiz' },
  { value: 'survey', label: 'Survey Page', category: 'quiz' },
  { value: 'assessment', label: 'Assessment', category: 'quiz' },
  // Sales Pages
  { value: 'sales_letter', label: 'Sales Letter', category: 'sales' },
  { value: 'product_page', label: 'Product Page', category: 'sales' },
  { value: 'offer_page', label: 'Offer Page', category: 'sales' },
  { value: 'checkout', label: 'Checkout', category: 'sales' },
  // Post-Purchase
  { value: 'thank_you', label: 'Thank You Page', category: 'postpurchase' },
  { value: 'upsell', label: 'Upsell Page', category: 'postpurchase' },
  { value: 'downsell', label: 'Downsell Page', category: 'postpurchase' },
  { value: 'oto', label: 'OTO (One Time Offer)', category: 'postpurchase' },
  { value: 'order_confirmation', label: 'Order Confirmation', category: 'postpurchase' },
  { value: 'membership', label: 'Membership Page', category: 'postpurchase' },
  // Content Pages
  { value: 'blog', label: 'Blog Post', category: 'content' },
  { value: 'article', label: 'Article', category: 'content' },
  { value: 'content_page', label: 'Content Page', category: 'content' },
  { value: 'review', label: 'Review Page', category: 'content' },
  // Compliance & Safe
  { value: 'safe_page', label: 'Safe Page', category: 'compliance' },
  { value: 'privacy', label: 'Privacy Policy', category: 'compliance' },
  { value: 'terms', label: 'Terms & Conditions', category: 'compliance' },
  { value: 'disclaimer', label: 'Disclaimer', category: 'compliance' },
  // Other
  { value: 'other', label: 'Other', category: 'other' },
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
