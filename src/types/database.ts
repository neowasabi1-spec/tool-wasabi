export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type PageType = 
  | '5_reasons_listicle' 
  | 'quiz_funnel' 
  | 'landing' 
  | 'product_page' 
  | 'safe_page' 
  | 'checkout'
  | 'advertorial'
  | 'altro'
  | (string & {}); // allow custom page types from Templates

export type SwipeStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type PostPurchaseType = 'thank_you' | 'upsell_1' | 'upsell_2' | 'downsell' | 'order_confirmation';

export type ViewFormat = 'desktop' | 'mobile';

export interface Database {
  public: {
    Tables: {
      products: {
        Row: {
          id: string;
          name: string;
          description: string;
          price: number;
          image_url: string | null;
          benefits: string[];
          cta_text: string;
          cta_url: string;
          brand_name: string;
          sku: string | null;
          category: string | null;
          characteristics: string[];
          geo_market: string | null;
          supplier: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description: string;
          price: number;
          image_url?: string | null;
          benefits: string[];
          cta_text: string;
          cta_url: string;
          brand_name: string;
          sku?: string | null;
          category?: string | null;
          characteristics?: string[];
          geo_market?: string | null;
          supplier?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          description?: string;
          price?: number;
          image_url?: string | null;
          benefits?: string[];
          cta_text?: string;
          cta_url?: string;
          brand_name?: string;
          sku?: string | null;
          category?: string | null;
          characteristics?: string[];
          geo_market?: string | null;
          supplier?: string | null;
          updated_at?: string;
        };
      };
      swipe_templates: {
        Row: {
          id: string;
          name: string;
          source_url: string;
          page_type: PageType;
          view_format: ViewFormat;
          tags: string[];
          description: string | null;
          preview_image: string | null;
          project_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          source_url: string;
          page_type: PageType;
          view_format?: ViewFormat;
          tags?: string[];
          description?: string | null;
          preview_image?: string | null;
          project_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          source_url?: string;
          page_type?: PageType;
          view_format?: ViewFormat;
          project_id?: string | null;
          tags?: string[];
          description?: string | null;
          preview_image?: string | null;
          updated_at?: string;
        };
      };
      funnel_pages: {
        Row: {
          id: string;
          name: string;
          page_type: PageType;
          template_id: string | null;
          product_id: string;
          project_id: string | null;
          url_to_swipe: string;
          prompt: string | null;
          swipe_status: SwipeStatus;
          swipe_result: string | null;
          feedback: string | null;
          cloned_data: Json | null;
          swiped_data: Json | null;
          analysis_status: SwipeStatus | null;
          analysis_result: string | null;
          extracted_data: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          page_type: PageType;
          template_id?: string | null;
          product_id: string;
          project_id?: string | null;
          url_to_swipe: string;
          prompt?: string | null;
          swipe_status?: SwipeStatus;
          swipe_result?: string | null;
          feedback?: string | null;
          cloned_data?: Json | null;
          swiped_data?: Json | null;
          analysis_status?: SwipeStatus | null;
          analysis_result?: string | null;
          extracted_data?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          page_type?: PageType;
          template_id?: string | null;
          product_id?: string;
          project_id?: string | null;
          url_to_swipe?: string;
          prompt?: string | null;
          swipe_status?: SwipeStatus;
          swipe_result?: string | null;
          feedback?: string | null;
          cloned_data?: Json | null;
          swiped_data?: Json | null;
          analysis_status?: SwipeStatus | null;
          analysis_result?: string | null;
          extracted_data?: Json | null;
          updated_at?: string;
        };
      };
      post_purchase_pages: {
        Row: {
          id: string;
          name: string;
          type: PostPurchaseType;
          product_id: string;
          url_to_swipe: string;
          swipe_status: SwipeStatus;
          swipe_result: string | null;
          cloned_data: Json | null;
          swiped_data: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          type: PostPurchaseType;
          product_id: string;
          url_to_swipe: string;
          swipe_status?: SwipeStatus;
          swipe_result?: string | null;
          cloned_data?: Json | null;
          swiped_data?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          type?: PostPurchaseType;
          product_id?: string;
          url_to_swipe?: string;
          swipe_status?: SwipeStatus;
          swipe_result?: string | null;
          cloned_data?: Json | null;
          swiped_data?: Json | null;
          updated_at?: string;
        };
      };
      funnel_crawl_steps: {
        Row: {
          id: string;
          funnel_name: string;
          funnel_tag: string | null;
          entry_url: string;
          step_index: number;
          url: string;
          title: string;
          step_data: Json;
          screenshot_base64: string | null;
          vision_analysis: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          funnel_name?: string;
          funnel_tag?: string | null;
          entry_url: string;
          step_index: number;
          url: string;
          title?: string;
          step_data?: Json;
          screenshot_base64?: string | null;
          vision_analysis?: Json | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          funnel_name?: string;
          funnel_tag?: string | null;
          entry_url?: string;
          step_index?: number;
          url?: string;
          title?: string;
          step_data?: Json;
          screenshot_base64?: string | null;
          vision_analysis?: Json | null;
          created_at?: string;
        };
      };
      affiliate_browser_chats: {
        Row: {
          id: string;
          prompt: string;
          start_url: string | null;
          max_turns: number;
          job_id: string | null;
          status: string;
          result: string | null;
          error: string | null;
          turns_used: number;
          final_url: string | null;
          created_at: string;
          updated_at: string;
          finished_at: string | null;
        };
        Insert: {
          id?: string;
          prompt: string;
          start_url?: string | null;
          max_turns?: number;
          job_id?: string | null;
          status?: string;
          result?: string | null;
          error?: string | null;
          turns_used?: number;
          final_url?: string | null;
          created_at?: string;
          updated_at?: string;
          finished_at?: string | null;
        };
        Update: {
          id?: string;
          prompt?: string;
          start_url?: string | null;
          max_turns?: number;
          job_id?: string | null;
          status?: string;
          result?: string | null;
          error?: string | null;
          turns_used?: number;
          final_url?: string | null;
          updated_at?: string;
          finished_at?: string | null;
        };
      };
      affiliate_saved_funnels: {
        Row: {
          id: string;
          chat_id: string | null;
          funnel_name: string;
          brand_name: string | null;
          entry_url: string;
          funnel_type: string;
          category: string;
          tags: string[];
          total_steps: number;
          steps: Json;
          analysis_summary: string | null;
          persuasion_techniques: string[];
          lead_capture_method: string | null;
          notable_elements: string[];
          raw_agent_result: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          chat_id?: string | null;
          funnel_name: string;
          brand_name?: string | null;
          entry_url: string;
          funnel_type?: string;
          category?: string;
          tags?: string[];
          total_steps?: number;
          steps?: Json;
          analysis_summary?: string | null;
          persuasion_techniques?: string[];
          lead_capture_method?: string | null;
          notable_elements?: string[];
          raw_agent_result: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          chat_id?: string | null;
          funnel_name?: string;
          brand_name?: string | null;
          entry_url?: string;
          funnel_type?: string;
          category?: string;
          tags?: string[];
          total_steps?: number;
          steps?: Json;
          analysis_summary?: string | null;
          persuasion_techniques?: string[];
          lead_capture_method?: string | null;
          notable_elements?: string[];
          raw_agent_result?: string;
          updated_at?: string;
        };
      };
      saved_prompts: {
        Row: {
          id: string;
          title: string;
          content: string;
          category: string;
          tags: string[];
          is_favorite: boolean;
          use_count: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          content: string;
          category?: string;
          tags?: string[];
          is_favorite?: boolean;
          use_count?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          content?: string;
          category?: string;
          tags?: string[];
          is_favorite?: boolean;
          use_count?: number;
          updated_at?: string;
        };
      };
      scheduled_browser_jobs: {
        Row: {
          id: string;
          template_id: string;
          title: string;
          prompt: string;
          start_url: string | null;
          max_turns: number;
          category: string;
          tags: string[];
          frequency: string;
          is_active: boolean;
          next_run_at: string;
          last_run_at: string | null;
          last_job_id: string | null;
          last_status: string | null;
          last_result: string | null;
          last_error: string | null;
          total_runs: number;
          successful_runs: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          template_id: string;
          title: string;
          prompt: string;
          start_url?: string | null;
          max_turns?: number;
          category?: string;
          tags?: string[];
          frequency?: string;
          is_active?: boolean;
          next_run_at?: string;
          last_run_at?: string | null;
          last_job_id?: string | null;
          last_status?: string | null;
          last_result?: string | null;
          last_error?: string | null;
          total_runs?: number;
          successful_runs?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          template_id?: string;
          title?: string;
          prompt?: string;
          start_url?: string | null;
          max_turns?: number;
          category?: string;
          tags?: string[];
          frequency?: string;
          is_active?: boolean;
          next_run_at?: string;
          last_run_at?: string | null;
          last_job_id?: string | null;
          last_status?: string | null;
          last_result?: string | null;
          last_error?: string | null;
          total_runs?: number;
          successful_runs?: number;
          updated_at?: string;
        };
      };
      archived_funnels: {
        Row: {
          id: string;
          name: string;
          total_steps: number;
          steps: Json;
          analysis: string | null;
          section: string;
          project_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          total_steps: number;
          steps: Json;
          analysis?: string | null;
          section?: string;
          project_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          total_steps?: number;
          steps?: Json;
          analysis?: string | null;
          section?: string;
          project_id?: string | null;
        };
      };
      projects: {
        Row: {
          id: string;
          name: string;
          description: string;
          status: string;
          tags: string[];
          notes: string | null;
          domain: string;
          logo: Json;
          market_research: Json;
          brief: string;
          front_end: Json;
          back_end: Json;
          compliance_funnel: Json;
          funnel: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string;
          status?: string;
          tags?: string[];
          notes?: string | null;
          domain?: string;
          logo?: Json;
          market_research?: Json;
          brief?: string;
          front_end?: Json;
          back_end?: Json;
          compliance_funnel?: Json;
          funnel?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          description?: string;
          status?: string;
          tags?: string[];
          notes?: string | null;
          domain?: string;
          logo?: Json;
          market_research?: Json;
          brief?: string;
          front_end?: Json;
          back_end?: Json;
          compliance_funnel?: Json;
          funnel?: Json;
          updated_at?: string;
        };
      };
    };
  };
}

// Helper types for easier usage
export type Product = Database['public']['Tables']['products']['Row'];
export type ProductInsert = Database['public']['Tables']['products']['Insert'];
export type ProductUpdate = Database['public']['Tables']['products']['Update'];

export type Project = Database['public']['Tables']['projects']['Row'];
export type ProjectInsert = Database['public']['Tables']['projects']['Insert'];
export type ProjectUpdate = Database['public']['Tables']['projects']['Update'];

export type SwipeTemplate = Database['public']['Tables']['swipe_templates']['Row'];
export type SwipeTemplateInsert = Database['public']['Tables']['swipe_templates']['Insert'];
export type SwipeTemplateUpdate = Database['public']['Tables']['swipe_templates']['Update'];

export type FunnelPage = Database['public']['Tables']['funnel_pages']['Row'];
export type FunnelPageInsert = Database['public']['Tables']['funnel_pages']['Insert'];
export type FunnelPageUpdate = Database['public']['Tables']['funnel_pages']['Update'];

export type PostPurchasePage = Database['public']['Tables']['post_purchase_pages']['Row'];
export type PostPurchasePageInsert = Database['public']['Tables']['post_purchase_pages']['Insert'];
export type PostPurchasePageUpdate = Database['public']['Tables']['post_purchase_pages']['Update'];

export type FunnelCrawlStepRow = Database['public']['Tables']['funnel_crawl_steps']['Row'];
export type FunnelCrawlStepInsert = Database['public']['Tables']['funnel_crawl_steps']['Insert'];

export type AffiliateBrowserChat = Database['public']['Tables']['affiliate_browser_chats']['Row'];
export type AffiliateBrowserChatInsert = Database['public']['Tables']['affiliate_browser_chats']['Insert'];
export type AffiliateBrowserChatUpdate = Database['public']['Tables']['affiliate_browser_chats']['Update'];

export type AffiliateSavedFunnel = Database['public']['Tables']['affiliate_saved_funnels']['Row'];
export type AffiliateSavedFunnelInsert = Database['public']['Tables']['affiliate_saved_funnels']['Insert'];
export type AffiliateSavedFunnelUpdate = Database['public']['Tables']['affiliate_saved_funnels']['Update'];

export type ScheduledBrowserJob = Database['public']['Tables']['scheduled_browser_jobs']['Row'];
export type ScheduledBrowserJobInsert = Database['public']['Tables']['scheduled_browser_jobs']['Insert'];
export type ScheduledBrowserJobUpdate = Database['public']['Tables']['scheduled_browser_jobs']['Update'];

export type SavedPrompt = Database['public']['Tables']['saved_prompts']['Row'];
export type SavedPromptInsert = Database['public']['Tables']['saved_prompts']['Insert'];
export type SavedPromptUpdate = Database['public']['Tables']['saved_prompts']['Update'];

export type ArchivedFunnel = Database['public']['Tables']['archived_funnels']['Row'];
export type ArchivedFunnelInsert = Database['public']['Tables']['archived_funnels']['Insert'];

// API Keys
export interface ApiKeyRow {
  id: string;
  name: string;
  description: string;
  key_hash: string;
  key_prefix: string;
  permissions: ApiPermission[];
  is_active: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ApiPermission =
  | 'full_access'
  | 'read_products'
  | 'write_products'
  | 'read_funnels'
  | 'write_funnels'
  | 'read_templates'
  | 'write_templates'
  | 'read_archive'
  | 'write_archive'
  | 'ai_chat'
  | 'ai_analysis'
  | 'clone_swipe'
  | 'deploy';

export const API_PERMISSION_OPTIONS: { value: ApiPermission; label: string; description: string; category: string }[] = [
  { value: 'full_access', label: 'Full Access', description: 'Unrestricted access to all endpoints and data', category: 'Global' },
  { value: 'read_products', label: 'Read Products', description: 'View products and product briefs', category: 'Products' },
  { value: 'write_products', label: 'Write Products', description: 'Create, update, delete products', category: 'Products' },
  { value: 'read_funnels', label: 'Read Funnels', description: 'View funnel pages and steps', category: 'Funnels' },
  { value: 'write_funnels', label: 'Write Funnels', description: 'Create, update, delete funnel pages', category: 'Funnels' },
  { value: 'read_templates', label: 'Read Templates', description: 'View swipe templates', category: 'Templates' },
  { value: 'write_templates', label: 'Write Templates', description: 'Create, update, delete templates', category: 'Templates' },
  { value: 'read_archive', label: 'Read Archive', description: 'View archived/saved funnels', category: 'Archive' },
  { value: 'write_archive', label: 'Write Archive', description: 'Create, update archived funnels', category: 'Archive' },
  { value: 'ai_chat', label: 'AI Chat', description: 'Use AI chat endpoints (funnel brief, product chat)', category: 'AI' },
  { value: 'ai_analysis', label: 'AI Analysis', description: 'Run AI analysis (copy, landing, funnel)', category: 'AI' },
  { value: 'clone_swipe', label: 'Clone & Swipe', description: 'Clone pages and run swipe pipeline', category: 'Operations' },
  { value: 'deploy', label: 'Deploy', description: 'Deploy funnels to external platforms', category: 'Operations' },
];

// Agentic Swipe types
export interface AgenticSwipeInput {
  url: string;
  productName: string;
  productDescription: string;
  target?: string;
  priceInfo?: string;
  customInstructions?: string;
  language?: string;
}

export interface AgenticSwipeResult {
  html: string;
  productAnalysis: Record<string, unknown>;
  landingAnalysis: Record<string, unknown>;
  croPlan: Record<string, unknown>;
}
