'use client';

import { create } from 'zustand';
import { SwipeApiResponse } from '@/types';
import type {
  Product,
  Project,
  SwipeTemplate,
  FunnelPage,
  PostPurchasePage,
  ArchivedFunnel,
  PageType,
  SwipeStatus,
  PostPurchaseType,
} from '@/types/database';
import * as supabaseOps from '@/lib/supabase-operations';

const SWIPE_API_URL = 'https://claude-code-agents.fly.dev/api/landing/swipe';

// Helper to convert database types to app types
interface AppProduct {
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

interface ProjectAsset {
  url: string;
  name: string;
  addedAt: string;
}

interface ProjectMarketResearch {
  targetAudience?: string;
  competitors?: string;
  positioning?: string;
  notes?: string;
}

interface ProjectSelectedProduct {
  productId?: string;
  manualName: string;
  manualDescription?: string;
}

interface AppProject {
  id: string;
  name: string;
  description: string;
  status: string;
  tags: string[];
  notes?: string;
  logo: ProjectAsset[];
  mockup: ProjectAsset[];
  label: ProjectAsset[];
  marketResearch: ProjectMarketResearch;
  selectedProducts: ProjectSelectedProduct[];
  flowSteps: string[][];
  brief: string;
  createdAt: Date;
  updatedAt: Date;
}

type ViewFormat = 'desktop' | 'mobile';

interface AppSwipeTemplate {
  id: string;
  name: string;
  sourceUrl: string;
  pageType: PageType;
  viewFormat: ViewFormat;
  tags: string[];
  description?: string;
  previewImage?: string;
  category?: 'standard' | 'quiz';
  createdAt: Date;
}

interface AppFunnelPage {
  id: string;
  name: string;
  pageType: PageType;
  templateId?: string;
  productId: string;
  urlToSwipe: string;
  prompt?: string;
  swipeStatus: SwipeStatus;
  swipeResult?: string;
  feedback?: string;
  clonedData?: {
    html: string;
    mobileHtml?: string;
    title: string;
    method_used: string;
    content_length: number;
    duration_seconds: number;
    cloned_at: Date;
  };
  swipedData?: {
    html: string;
    originalTitle: string;
    newTitle: string;
    originalLength: number;
    newLength: number;
    processingTime: number;
    methodUsed: string;
    changesMade: string[];
    swipedAt: Date;
  };
  analysisStatus?: SwipeStatus;
  analysisResult?: string;
  extractedData?: {
    headline: string;
    subheadline: string;
    cta: string[];
    price: string | null;
    benefits: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

interface AppPostPurchasePage {
  id: string;
  name: string;
  type: PostPurchaseType;
  productId: string;
  urlToSwipe: string;
  swipeStatus: SwipeStatus;
  swipeResult?: string;
  clonedData?: {
    html: string;
    title: string;
    method_used: string;
    content_length: number;
    duration_seconds: number;
    cloned_at: Date;
  };
  swipedData?: {
    html: string;
    originalTitle: string;
    newTitle: string;
    originalLength: number;
    newLength: number;
    processingTime: number;
    methodUsed: string;
    changesMade: string[];
    swipedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

// Conversion functions
function dbProductToApp(p: Product): AppProduct {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    imageUrl: p.image_url || undefined,
    benefits: p.benefits,
    ctaText: p.cta_text,
    ctaUrl: p.cta_url,
    brandName: p.brand_name,
    sku: p.sku || undefined,
    category: p.category || undefined,
    characteristics: p.characteristics || [],
    geoMarket: p.geo_market || undefined,
    supplier: p.supplier || undefined,
    createdAt: new Date(p.created_at),
  };
}

function dbProjectToApp(p: Project): AppProject {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    tags: p.tags,
    notes: p.notes || undefined,
    logo: (p.logo as ProjectAsset[]) || [],
    mockup: (p.mockup as ProjectAsset[]) || [],
    label: (p.label as ProjectAsset[]) || [],
    marketResearch: (p.market_research as ProjectMarketResearch) || {},
    selectedProducts: (p.selected_products as ProjectSelectedProduct[]) || [],
    flowSteps: (p.flow_steps as string[][]) || [[], [], [], [], [], []],
    brief: p.brief || '',
    createdAt: new Date(p.created_at),
    updatedAt: new Date(p.updated_at),
  };
}

function dbTemplateToApp(t: SwipeTemplate): AppSwipeTemplate {
  const row = t as SwipeTemplate & { category?: 'standard' | 'quiz' };
  return {
    id: t.id,
    name: t.name,
    sourceUrl: t.source_url,
    pageType: t.page_type,
    viewFormat: (t.view_format as ViewFormat) || 'desktop',
    tags: t.tags,
    description: t.description || undefined,
    previewImage: t.preview_image || undefined,
    category: row.category || 'standard',
    createdAt: new Date(t.created_at),
  };
}

function dbFunnelPageToApp(p: FunnelPage): AppFunnelPage {
  return {
    id: p.id,
    name: p.name,
    pageType: p.page_type,
    templateId: p.template_id || undefined,
    productId: p.product_id,
    urlToSwipe: p.url_to_swipe,
    prompt: (p as Record<string, unknown>).prompt as string | undefined,
    swipeStatus: p.swipe_status,
    swipeResult: p.swipe_result || undefined,
    feedback: (p as Record<string, unknown>).feedback as string | undefined,
    clonedData: p.cloned_data as AppFunnelPage['clonedData'],
    swipedData: p.swiped_data as AppFunnelPage['swipedData'],
    analysisStatus: p.analysis_status || undefined,
    analysisResult: p.analysis_result || undefined,
    extractedData: p.extracted_data as AppFunnelPage['extractedData'],
    createdAt: new Date(p.created_at),
    updatedAt: new Date(p.updated_at),
  };
}

function dbPostPurchaseToApp(p: PostPurchasePage): AppPostPurchasePage {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    productId: p.product_id,
    urlToSwipe: p.url_to_swipe,
    swipeStatus: p.swipe_status,
    swipeResult: p.swipe_result || undefined,
    clonedData: p.cloned_data as AppPostPurchasePage['clonedData'],
    swipedData: p.swiped_data as AppPostPurchasePage['swipedData'],
    createdAt: new Date(p.created_at),
    updatedAt: new Date(p.updated_at),
  };
}

interface Store {
  // Loading state
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;

  // Initialize data from Supabase
  initializeData: () => Promise<void>;

  // Templates
  templates: AppSwipeTemplate[];
  addTemplate: (template: Omit<AppSwipeTemplate, 'id' | 'createdAt'>) => Promise<void>;
  updateTemplate: (id: string, template: Partial<AppSwipeTemplate>) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;

  // Products
  products: AppProduct[];
  addProduct: (product: Omit<AppProduct, 'id' | 'createdAt'>) => Promise<void>;
  updateProduct: (id: string, product: Partial<AppProduct>) => Promise<void>;
  deleteProduct: (id: string) => Promise<void>;

  // Projects
  projects: AppProject[];
  addProject: (project: Omit<AppProject, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateProject: (id: string, project: Partial<AppProject>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  // Custom page types (per Templates)
  customPageTypes: { value: string; label: string }[];
  addCustomPageType: (label: string) => void;
  deleteCustomPageType: (value: string) => void;

  // Front End Funnel Pages
  funnelPages: AppFunnelPage[];
  addFunnelPage: (page: Omit<AppFunnelPage, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateFunnelPage: (id: string, page: Partial<AppFunnelPage>) => Promise<void>;
  deleteFunnelPage: (id: string) => Promise<void>;
  launchSwipe: (id: string) => Promise<void>;

  // Post Purchase Pages
  postPurchasePages: AppPostPurchasePage[];
  addPostPurchasePage: (page: Omit<AppPostPurchasePage, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updatePostPurchasePage: (id: string, page: Partial<AppPostPurchasePage>) => Promise<void>;
  deletePostPurchasePage: (id: string) => Promise<void>;
  launchPostPurchaseSwipe: (id: string) => Promise<void>;

  // Archived Funnels
  archivedFunnels: ArchivedFunnel[];
  archivedFunnelsLoaded: boolean;
  loadArchivedFunnels: () => Promise<void>;
  saveCurrentFunnelAsArchive: (name: string) => Promise<void>;
  deleteArchivedFunnel: (id: string) => Promise<void>;
}

export const useStore = create<Store>()((set, get) => ({
  // Loading state
  isLoading: true,
  error: null,
  isInitialized: false,

  // Initialize data from Supabase (with timeout to prevent infinite loading)
  initializeData: async () => {
    if (get().isInitialized) return;

    const SUPABASE_INIT_TIMEOUT_MS = 12_000;

    set({ isLoading: true, error: null });

    const fetchWithTimeout = <T>(promise: Promise<T>): Promise<T> => {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout: Supabase did not respond within 12 seconds')), SUPABASE_INIT_TIMEOUT_MS)
        ),
      ]);
    };

    try {
      const [products, projects, templates, funnelPages, postPurchasePages] = await fetchWithTimeout(
        Promise.all([
          supabaseOps.fetchProducts(),
          supabaseOps.fetchProjects().catch(() => [] as Project[]),
          supabaseOps.fetchTemplates(),
          supabaseOps.fetchFunnelPages(),
          supabaseOps.fetchPostPurchasePages(),
        ])
      );

      set({
        products: products.map(dbProductToApp),
        projects: projects.map(dbProjectToApp),
        templates: templates.map(dbTemplateToApp),
        funnelPages: funnelPages.map(dbFunnelPageToApp),
        postPurchasePages: postPurchasePages.map(dbPostPurchaseToApp),
        isLoading: false,
        isInitialized: true,
      });
    } catch (error) {
      console.error('Error initializing data from Supabase:', error);
      set({
        error: error instanceof Error ? error.message : 'Supabase connection error',
        isLoading: false,
      });
    }
  },

  // Templates
  templates: [],

  addTemplate: async (template) => {
    try {
      const created = await supabaseOps.createTemplate({
        name: template.name,
        source_url: template.sourceUrl,
        page_type: template.pageType,
        view_format: template.viewFormat || 'desktop',
        tags: template.tags,
        description: template.description,
        preview_image: template.previewImage,
      });
      
      set((state) => ({
        templates: [dbTemplateToApp(created), ...state.templates],
      }));
    } catch (error) {
      console.error('Error adding template:', error);
      throw error;
    }
  },

  updateTemplate: async (id, template) => {
    try {
      const updated = await supabaseOps.updateTemplate(id, {
        name: template.name,
        source_url: template.sourceUrl,
        page_type: template.pageType,
        view_format: template.viewFormat,
        tags: template.tags,
        description: template.description,
        preview_image: template.previewImage,
      });
      
      set((state) => ({
        templates: state.templates.map((t) =>
          t.id === id ? dbTemplateToApp(updated) : t
        ),
      }));
    } catch (error) {
      console.error('Error updating template:', error);
      throw error;
    }
  },

  deleteTemplate: async (id) => {
    try {
      await supabaseOps.deleteTemplate(id);
      set((state) => ({
        templates: state.templates.filter((t) => t.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting template:', error);
      throw error;
    }
  },

  // Products
  products: [],

  addProduct: async (product) => {
    try {
      const created = await supabaseOps.createProduct({
        name: product.name,
        description: product.description,
        price: product.price,
        image_url: product.imageUrl,
        benefits: product.benefits,
        cta_text: product.ctaText,
        cta_url: product.ctaUrl,
        brand_name: product.brandName,
        sku: product.sku,
        category: product.category,
        characteristics: product.characteristics,
        geo_market: product.geoMarket,
        supplier: product.supplier,
      });
      
      set((state) => ({
        products: [dbProductToApp(created), ...state.products],
      }));
    } catch (error) {
      console.error('Error adding product:', error);
      throw error;
    }
  },

  updateProduct: async (id, product) => {
    try {
      const updated = await supabaseOps.updateProduct(id, {
        name: product.name,
        description: product.description,
        price: product.price,
        image_url: product.imageUrl,
        benefits: product.benefits,
        cta_text: product.ctaText,
        cta_url: product.ctaUrl,
        brand_name: product.brandName,
        sku: product.sku,
        category: product.category,
        characteristics: product.characteristics,
        geo_market: product.geoMarket,
        supplier: product.supplier,
      });
      
      set((state) => ({
        products: state.products.map((p) =>
          p.id === id ? dbProductToApp(updated) : p
        ),
      }));
    } catch (error) {
      console.error('Error updating product:', error);
      throw error;
    }
  },

  deleteProduct: async (id) => {
    try {
      await supabaseOps.deleteProduct(id);
      set((state) => ({
        products: state.products.filter((p) => p.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting product:', error);
      throw error;
    }
  },

  // Projects
  projects: [],

  addProject: async (project) => {
    try {
      const created = await supabaseOps.createProject({
        name: project.name,
        description: project.description,
        status: project.status,
        tags: project.tags,
        notes: project.notes,
        logo: project.logo as unknown as import('@/types/database').Json,
        mockup: project.mockup as unknown as import('@/types/database').Json,
        label: project.label as unknown as import('@/types/database').Json,
        market_research: project.marketResearch as unknown as import('@/types/database').Json,
        selected_products: project.selectedProducts as unknown as import('@/types/database').Json,
        flow_steps: project.flowSteps as unknown as import('@/types/database').Json,
        brief: project.brief,
      });
      set((state) => ({
        projects: [dbProjectToApp(created), ...state.projects],
      }));
    } catch (error) {
      console.error('Error adding project:', error);
      throw error;
    }
  },

  updateProject: async (id, project) => {
    try {
      const updates: import('@/types/database').ProjectUpdate = {};
      if (project.name !== undefined) updates.name = project.name;
      if (project.description !== undefined) updates.description = project.description;
      if (project.status !== undefined) updates.status = project.status;
      if (project.tags !== undefined) updates.tags = project.tags;
      if (project.notes !== undefined) updates.notes = project.notes;
      if (project.logo !== undefined) updates.logo = project.logo as unknown as import('@/types/database').Json;
      if (project.mockup !== undefined) updates.mockup = project.mockup as unknown as import('@/types/database').Json;
      if (project.label !== undefined) updates.label = project.label as unknown as import('@/types/database').Json;
      if (project.marketResearch !== undefined) updates.market_research = project.marketResearch as unknown as import('@/types/database').Json;
      if (project.selectedProducts !== undefined) updates.selected_products = project.selectedProducts as unknown as import('@/types/database').Json;
      if (project.flowSteps !== undefined) updates.flow_steps = project.flowSteps as unknown as import('@/types/database').Json;
      if (project.brief !== undefined) updates.brief = project.brief;
      const updated = await supabaseOps.updateProject(id, updates);
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === id ? dbProjectToApp(updated) : p
        ),
      }));
    } catch (error) {
      console.error('Error updating project:', error);
      throw error;
    }
  },

  deleteProject: async (id) => {
    try {
      await supabaseOps.deleteProject(id);
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting project:', error);
      throw error;
    }
  },

  // Custom page types (in-memory, per Templates)
  customPageTypes: [],
  addCustomPageType: (label) => {
    const value = label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!value) return;
    set((s) => {
      if (s.customPageTypes.some((ct) => ct.value === value)) return s;
      return {
        customPageTypes: [...s.customPageTypes, { value, label }],
      };
    });
  },
  deleteCustomPageType: (value) => {
    set((s) => ({
      customPageTypes: s.customPageTypes.filter((ct) => ct.value !== value),
    }));
  },

  // Front End Funnel Pages
  funnelPages: [],

  addFunnelPage: async (page) => {
    try {
      const created = await supabaseOps.createFunnelPage({
        name: page.name,
        page_type: page.pageType,
        template_id: page.templateId,
        product_id: page.productId,
        url_to_swipe: page.urlToSwipe,
        prompt: page.prompt,
        swipe_status: page.swipeStatus,
        swipe_result: page.swipeResult,
        feedback: page.feedback,
        cloned_data: page.clonedData as unknown as Record<string, unknown>,
        swiped_data: page.swipedData as unknown as Record<string, unknown>,
        analysis_status: page.analysisStatus,
        analysis_result: page.analysisResult,
        extracted_data: page.extractedData as unknown as Record<string, unknown>,
      } as Parameters<typeof supabaseOps.createFunnelPage>[0]);
      
      set((state) => ({
        funnelPages: [...state.funnelPages, dbFunnelPageToApp(created)],
      }));
    } catch (error) {
      console.error('Error adding funnel page:', error);
      throw error;
    }
  },

  updateFunnelPage: async (id, page) => {
    const prev = get().funnelPages.find((p) => p.id === id);
    // Optimistic: update local state immediately so UI stays responsive
    set((state) => ({
      funnelPages: state.funnelPages.map((p) =>
        p.id === id ? { ...p, ...page } : p
      ),
    }));
    try {
      const updated = await supabaseOps.updateFunnelPage(id, {
        name: page.name,
        page_type: page.pageType,
        template_id: page.templateId,
        product_id: page.productId,
        url_to_swipe: page.urlToSwipe,
        prompt: page.prompt,
        swipe_status: page.swipeStatus,
        swipe_result: page.swipeResult,
        feedback: page.feedback,
        cloned_data: page.clonedData as unknown as Record<string, unknown>,
        swiped_data: page.swipedData as unknown as Record<string, unknown>,
        analysis_status: page.analysisStatus,
        analysis_result: page.analysisResult,
        extracted_data: page.extractedData as unknown as Record<string, unknown>,
      } as Parameters<typeof supabaseOps.updateFunnelPage>[1]);
      
      set((state) => ({
        funnelPages: state.funnelPages.map((p) =>
          p.id === id ? dbFunnelPageToApp(updated) : p
        ),
      }));
    } catch (error) {
      // Revert on failure
      if (prev) {
        set((state) => ({
          funnelPages: state.funnelPages.map((p) =>
            p.id === id ? prev : p
          ),
        }));
      }
      console.error('Error updating funnel page:', error);
      throw error;
    }
  },

  deleteFunnelPage: async (id) => {
    try {
      await supabaseOps.deleteFunnelPage(id);
      set((state) => ({
        funnelPages: state.funnelPages.filter((p) => p.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting funnel page:', error);
      throw error;
    }
  },

  launchSwipe: async (id) => {
    const page = get().funnelPages.find((p) => p.id === id);
    if (!page || !page.urlToSwipe) return;

    const product = get().products.find((p) => p.id === page.productId);
    if (!product) {
      await get().updateFunnelPage(id, {
        swipeStatus: 'failed',
        swipeResult: 'Select a product before launching the swipe',
      });
      return;
    }

    await get().updateFunnelPage(id, { swipeStatus: 'in_progress' });

    try {
      const response = await fetch(SWIPE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: page.urlToSwipe,
          product: {
            name: product.name,
            description: product.description,
            benefits: product.benefits,
            cta_text: product.ctaText,
            cta_url: product.ctaUrl,
            brand_name: product.brandName,
          },
          language: 'it',
        }),
      });

      const data: SwipeApiResponse = await response.json();

      if (!response.ok || !data.success) {
        await get().updateFunnelPage(id, {
          swipeStatus: 'failed',
          swipeResult: data.error || 'Error during swipe',
        });
        return;
      }

      await get().updateFunnelPage(id, {
        swipeStatus: 'completed',
        swipeResult: `✓ Swipe completed: "${data.new_title}" (${data.new_length} chars, ${data.processing_time_seconds.toFixed(2)}s)`,
        swipedData: {
          html: data.html,
          originalTitle: data.original_title,
          newTitle: data.new_title,
          originalLength: data.original_length,
          newLength: data.new_length,
          processingTime: data.processing_time_seconds,
          methodUsed: data.method_used,
          changesMade: data.changes_made,
          swipedAt: new Date(),
        },
      });
    } catch (error) {
      await get().updateFunnelPage(id, {
        swipeStatus: 'failed',
        swipeResult: error instanceof Error ? error.message : 'Network error',
      });
    }
  },

  // Post Purchase Pages
  postPurchasePages: [],

  addPostPurchasePage: async (page) => {
    try {
      const created = await supabaseOps.createPostPurchasePage({
        name: page.name,
        type: page.type,
        product_id: page.productId,
        url_to_swipe: page.urlToSwipe,
        swipe_status: page.swipeStatus,
        swipe_result: page.swipeResult,
        cloned_data: page.clonedData as unknown as Record<string, unknown>,
        swiped_data: page.swipedData as unknown as Record<string, unknown>,
      });
      
      set((state) => ({
        postPurchasePages: [dbPostPurchaseToApp(created), ...state.postPurchasePages],
      }));
    } catch (error) {
      console.error('Error adding post purchase page:', error);
      throw error;
    }
  },

  updatePostPurchasePage: async (id, page) => {
    try {
      const updated = await supabaseOps.updatePostPurchasePage(id, {
        name: page.name,
        type: page.type,
        product_id: page.productId,
        url_to_swipe: page.urlToSwipe,
        swipe_status: page.swipeStatus,
        swipe_result: page.swipeResult,
        cloned_data: page.clonedData as unknown as Record<string, unknown>,
        swiped_data: page.swipedData as unknown as Record<string, unknown>,
      });
      
      set((state) => ({
        postPurchasePages: state.postPurchasePages.map((p) =>
          p.id === id ? dbPostPurchaseToApp(updated) : p
        ),
      }));
    } catch (error) {
      console.error('Error updating post purchase page:', error);
      throw error;
    }
  },

  deletePostPurchasePage: async (id) => {
    try {
      await supabaseOps.deletePostPurchasePage(id);
      set((state) => ({
        postPurchasePages: state.postPurchasePages.filter((p) => p.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting post purchase page:', error);
      throw error;
    }
  },

  launchPostPurchaseSwipe: async (id) => {
    const page = get().postPurchasePages.find((p) => p.id === id);
    if (!page || !page.urlToSwipe) return;

    const product = get().products.find((p) => p.id === page.productId);
    if (!product) {
      await get().updatePostPurchasePage(id, {
        swipeStatus: 'failed',
        swipeResult: 'Select a product before launching the swipe',
      });
      return;
    }

    await get().updatePostPurchasePage(id, { swipeStatus: 'in_progress' });

    try {
      const response = await fetch(SWIPE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: page.urlToSwipe,
          product: {
            name: product.name,
            description: product.description,
            benefits: product.benefits,
            cta_text: product.ctaText,
            cta_url: product.ctaUrl,
            brand_name: product.brandName,
          },
          language: 'it',
        }),
      });

      const data: SwipeApiResponse = await response.json();

      if (!response.ok || !data.success) {
        await get().updatePostPurchasePage(id, {
          swipeStatus: 'failed',
          swipeResult: data.error || 'Error during swipe',
        });
        return;
      }

      await get().updatePostPurchasePage(id, {
        swipeStatus: 'completed',
        swipeResult: `✓ Swipe completed: "${data.new_title}" (${data.new_length} chars)`,
        swipedData: {
          html: data.html,
          originalTitle: data.original_title,
          newTitle: data.new_title,
          originalLength: data.original_length,
          newLength: data.new_length,
          processingTime: data.processing_time_seconds,
          methodUsed: data.method_used,
          changesMade: data.changes_made,
          swipedAt: new Date(),
        },
      });
    } catch (error) {
      await get().updatePostPurchasePage(id, {
        swipeStatus: 'failed',
        swipeResult: error instanceof Error ? error.message : 'Network error',
      });
    }
  },

  // Archived Funnels
  archivedFunnels: [],
  archivedFunnelsLoaded: false,

  loadArchivedFunnels: async () => {
    if (get().archivedFunnelsLoaded) return;
    try {
      const data = await supabaseOps.fetchArchivedFunnels();
      set({ archivedFunnels: data, archivedFunnelsLoaded: true });
    } catch (error) {
      console.error('Error loading archived funnels:', error);
    }
  },

  saveCurrentFunnelAsArchive: async (name: string) => {
    const pages = get().funnelPages;
    const products = get().products;
    const templates = get().templates;
    if (!pages || pages.length === 0) return;

    const steps = pages.map((p, i) => ({
      step_index: i + 1,
      name: p.name,
      page_type: p.pageType,
      template_name: templates.find(t => t.id === p.templateId)?.name || '',
      product_name: products.find(pr => pr.id === p.productId)?.name || '',
      url_to_swipe: p.urlToSwipe,
      prompt: p.prompt || '',
      feedback: p.feedback || '',
      swipe_status: p.swipeStatus,
      swipe_result: p.swipeResult || '',
      swiped_data: p.swipedData || null,
      cloned_data: p.clonedData || null,
    }));

    try {
      const created = await supabaseOps.createArchivedFunnel({
        name,
        total_steps: steps.length,
        steps: steps as unknown as import('@/types/database').Json,
      });
      set((state) => ({
        archivedFunnels: [created, ...state.archivedFunnels],
      }));
    } catch (error) {
      console.error('Error saving funnel to archive:', error);
      throw error;
    }
  },

  deleteArchivedFunnel: async (id: string) => {
    try {
      await supabaseOps.deleteArchivedFunnel(id);
      set((state) => ({
        archivedFunnels: state.archivedFunnels.filter((f) => f.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting archived funnel:', error);
      throw error;
    }
  },
}));
