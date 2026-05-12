import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { createHash, randomUUID } from 'crypto';

// Allow this route up to the Vercel maximum (300s on Pro). Anything longer
// MUST go through the async pattern (swipe_landing_page_async / swipe_status)
// because Vercel will hard-kill the function after maxDuration regardless.
export const maxDuration = 300;

const SERVER_INFO = {
  name: 'funnel-swiper-mcp',
  version: '1.3.0',
};

// MCP Streamable HTTP protocol version (2025-03-26 introduced Streamable HTTP)
const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Common headers returned on every response (CORS + protocol version)
function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Mcp-Session-Id, MCP-Protocol-Version, Accept',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    ...extra,
  };
}

type CatalogProductRow = Record<string, unknown> & {
  name: string;
  description: string;
  price?: unknown;
  benefits?: unknown;
  cta_text?: string;
  cta_url?: string;
  brand_name?: string;
};

function normalizeBenefitsList(benefits: unknown): string[] {
  if (!benefits) return [];
  if (Array.isArray(benefits)) return benefits.map((b) => String(b)).filter(Boolean);
  return String(benefits)
    .split(',')
    .map((b: string) => b.trim())
    .filter(Boolean);
}

/** Builds the `product` object for /api/landing/swipe incl. merged briefs from linked projects. */
async function buildSwipeProductPayload(
  prod: CatalogProductRow,
  opts: {
    marketing_brief?: string;
    additional_marketing_notes?: string;
    productIdForProjects?: string;
  },
): Promise<Record<string, unknown>> {
  const briefParts: string[] = [];
  if (opts.additional_marketing_notes?.trim()) briefParts.push(opts.additional_marketing_notes.trim());
  if (opts.marketing_brief?.trim()) briefParts.push(opts.marketing_brief.trim());

  if (opts.productIdForProjects) {
    const { data: funnelRows } = await supabase
      .from('funnel_pages')
      .select('project_id')
      .eq('product_id', opts.productIdForProjects)
      .not('project_id', 'is', null)
      .limit(25);

    const projectIds = [
      ...new Set((funnelRows ?? []).map((r: { project_id: string }) => r.project_id).filter(Boolean)),
    ];

    for (const pid of projectIds.slice(0, 5)) {
      const { data: proj } = await supabase
        .from('projects')
        .select('name, brief, market_research')
        .eq('id', pid)
        .maybeSingle();
      if (!proj) continue;
      if (typeof proj.brief === 'string' && proj.brief.trim()) {
        briefParts.push(`Project "${proj.name}":\n${proj.brief.trim()}`);
      }
      if (proj.market_research != null && proj.market_research !== '') {
        const mr =
          typeof proj.market_research === 'string'
            ? proj.market_research
            : JSON.stringify(proj.market_research);
        if (mr && mr !== '{}' && mr !== 'null') {
          briefParts.push(`Market research (${proj.name}):\n${mr}`);
        }
      }
    }
  }

  const out: Record<string, unknown> = {
    name: prod.name,
    description: prod.description,
    benefits: normalizeBenefitsList(prod.benefits),
    price: prod.price != null && String(prod.price).trim() !== '' ? String(prod.price) : undefined,
    cta_text: prod.cta_text,
    cta_url: prod.cta_url,
    brand_name: prod.brand_name,
  };

  const ta = prod.target_audience;
  if (typeof ta === 'string' && ta.trim()) out.target_audience = ta;

  const category = prod.category;
  if (typeof category === 'string' && category.trim()) out.category = category;
  const sku = prod.sku;
  if (typeof sku === 'string' && sku.trim()) out.sku = sku;
  const supplier = prod.supplier;
  if (typeof supplier === 'string' && supplier.trim()) out.supplier = supplier;
  const gm = prod.geo_market;
  if (typeof gm === 'string' && gm.trim()) out.geo_market = gm;

  const ch = prod.characteristics;
  if (Array.isArray(ch) && ch.length > 0) out.characteristics = ch.map(String);

  if (briefParts.length > 0) out.marketing_brief = briefParts.join('\n\n---\n\n');

  return out;
}

const TOOLS = [
  {
    name: 'list_products',
    description: 'List all products in the catalog',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_product',
    description: 'Create a new product in the catalog',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Product name' },
        description: { type: 'string', description: 'Product description' },
        price: { type: 'string', description: 'Product price' },
        benefits: { type: 'string', description: 'Product benefits (comma separated)' },
        cta_text: { type: 'string', description: 'CTA button text' },
        cta_url: { type: 'string', description: 'CTA URL' },
        target_audience: { type: 'string', description: 'Target audience' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_product',
    description: 'Update an existing product',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Product ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        price: { type: 'string' },
        benefits: { type: 'string' },
        cta_text: { type: 'string' },
        cta_url: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_product',
    description: 'Delete a product by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Product ID' } },
      required: ['id'],
    },
  },
  {
    name: 'list_funnels',
    description: 'List all funnel pages saved in the tool',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_funnel_page',
    description: 'Create a new funnel page (Front End Funnel). product_id + url_to_swipe are required by the DB.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Page name' },
        page_type: { type: 'string', description: 'Type: 5_reasons_listicle, quiz_funnel, landing, product_page, safe_page, checkout, advertorial, altro' },
        product_id: { type: 'string', description: 'Associated product ID (required)' },
        project_id: { type: 'string' },
        template_id: { type: 'string' },
        url_to_swipe: { type: 'string', description: 'Source URL to clone/swipe from (required)' },
        prompt: { type: 'string', description: 'Custom rewrite prompt' },
        swipe_status: { type: 'string', description: 'pending, in_progress, completed, failed (default pending)' },
        cloned_data: { type: 'object', description: 'JSON blob with cloned HTML and metadata' },
        swiped_data: { type: 'object', description: 'JSON blob with swiped (rewritten) HTML and metadata' },
      },
      required: ['name', 'product_id', 'url_to_swipe'],
    },
  },
  {
    name: 'update_funnel_page',
    description: 'Update an existing funnel page',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Funnel page ID' },
        name: { type: 'string' },
        page_type: { type: 'string' },
        product_id: { type: 'string' },
        project_id: { type: 'string' },
        url_to_swipe: { type: 'string' },
        prompt: { type: 'string' },
        swipe_status: { type: 'string' },
        swipe_result: { type: 'string' },
        feedback: { type: 'string' },
        cloned_data: { type: 'object' },
        swiped_data: { type: 'object' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_funnel_page',
    description: 'Delete a funnel page by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Funnel page ID' } },
      required: ['id'],
    },
  },
  {
    name: 'list_templates',
    description: 'List all saved swipe templates (My Templates section)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_template',
    description: 'Get a single swipe template by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_template',
    description: 'Save a new swipe template. source_url and page_type are required by the DB.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Template name' },
        source_url: { type: 'string', description: 'Source URL of the template (required)' },
        page_type: { type: 'string', description: 'Page type (required): 5_reasons_listicle, quiz_funnel, landing, product_page, safe_page, checkout, advertorial, altro' },
        view_format: { type: 'string', description: 'desktop or mobile (default desktop)' },
        tags: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
        preview_image: { type: 'string', description: 'URL of preview screenshot' },
        project_id: { type: 'string' },
      },
      required: ['name', 'source_url', 'page_type'],
    },
  },
  {
    name: 'update_template',
    description: 'Update an existing swipe template',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        source_url: { type: 'string' },
        page_type: { type: 'string' },
        view_format: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
        preview_image: { type: 'string' },
        project_id: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_template',
    description: 'Delete a swipe template by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_archive',
    description: 'List all archived funnels (My Archive section)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_archive_entry',
    description: 'Get a single archived funnel by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_archive_entry',
    description: 'Save a (multi-step) funnel to the archive. Real DB columns: name, total_steps (auto-calculated from steps.length if omitted), steps (JSON array), analysis (string), section, project_id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        steps: { type: 'array', description: 'Array of step objects with at least { step_index, name, url_to_swipe, page_type, prompt }' },
        total_steps: { type: 'number', description: 'Optional, auto-calculated from steps.length' },
        analysis: { type: 'string', description: 'AI analysis summary of the funnel' },
        section: { type: 'string', description: 'Section/category (default "archive")' },
        project_id: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_archive_entry',
    description: 'Update an archived funnel. Allowed columns: name, total_steps, steps, analysis, section, project_id. (No notes/url/html_content — those columns do NOT exist in the DB.)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        steps: { type: 'array' },
        total_steps: { type: 'number' },
        analysis: { type: 'string' },
        section: { type: 'string' },
        project_id: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_archive_entry',
    description: 'Delete an archived funnel by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'analyze_copy',
    description: 'Analyze the marketing copy of a landing page URL using AI',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the landing page to analyze' },
      },
      required: ['url'],
    },
  },
  {
    name: 'clone_landing_page',
    description: 'Clone a landing page HTML from a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the landing page to clone' },
      },
      required: ['url'],
    },
  },
  {
    name: 'send_openclaw_message',
    description: 'Send a message to OpenClaw AI assistant and get a response',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to send to OpenClaw' },
        section: { type: 'string', description: 'Context section (e.g. Dashboard, Products, etc.)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'generate_product_brief',
    description: 'Generate an AI product brief for a product',
    inputSchema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Product name' },
        product_description: { type: 'string', description: 'Product description' },
        target_audience: { type: 'string', description: 'Target audience' },
      },
      required: ['product_name'],
    },
  },
  {
    name: 'list_api_keys',
    description: 'List all API keys (without showing the actual key values)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_products',
    description: 'Search products by name or description',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'Get a single product by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Product ID' } },
      required: ['id'],
    },
  },
  {
    name: 'get_funnel_page',
    description: 'Get a single funnel page by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Funnel page ID' } },
      required: ['id'],
    },
  },
  {
    name: 'crawl_funnel',
    description: 'Start crawling a funnel from a URL to discover all pages',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Starting URL of the funnel to crawl' },
        max_pages: { type: 'number', description: 'Max pages to crawl (default 10)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'swipe_landing_page',
    description: 'Clone a landing page from a URL and rewrite all the copy for a specific product. Returns the full swiped HTML ready to use.',
    inputSchema: {
      type: 'object',
      properties: {
        source_url: { type: 'string', description: 'URL of the landing page to swipe' },
        product_name: { type: 'string', description: 'Name of the product to swipe for' },
        product_description: { type: 'string', description: 'Product description' },
        benefits: { type: 'string', description: 'Product benefits (comma separated)' },
        price: { type: 'string', description: 'Product price' },
        cta_text: { type: 'string', description: 'CTA button text' },
        cta_url: { type: 'string', description: 'CTA destination URL' },
        target_audience: { type: 'string', description: 'Target audience' },
        brand_name: { type: 'string', description: 'Brand name' },
        marketing_brief: {
          type: 'string',
          description:
            'Long positioning brief, strategist output, or funnel knowledge to ground rewrites (strongly recommended for full-page swipes)',
        },
        additional_marketing_notes: {
          type: 'string',
          description: 'Angles, objections, proofs, swipe notes merged into swipe context',
        },
        tone: { type: 'string', description: 'Copy tone: professional, casual, urgent, luxury (default: professional)' },
        language: { type: 'string', description: 'Language code: it, en, es, de, fr (default: it)' },
      },
      required: ['source_url', 'product_name'],
    },
  },
  {
    name: 'swipe_landing_for_product_id',
    description: 'Clone a landing page and swipe it using product data already saved in the tool (by product ID)',
    inputSchema: {
      type: 'object',
      properties: {
        source_url: { type: 'string', description: 'URL of the landing page to swipe' },
        product_id: { type: 'string', description: 'ID of the product (from list_products) to swipe for' },
        marketing_brief: {
          type: 'string',
          description: 'Extra brief / knowledge appended to swipe (in addition to DB product + linked project)',
        },
        additional_marketing_notes: { type: 'string', description: 'Optional notes merged into swipe context' },
        tone: { type: 'string', description: 'Copy tone (default: professional)' },
        language: { type: 'string', description: 'Language code (default: it)' },
      },
      required: ['source_url', 'product_id'],
    },
  },
  {
    name: 'swipe_landing_page_async',
    description: 'ASYNC variant of swipe_landing_page for long pages that exceed Vercel\'s 300s limit. Enqueues the swipe job in Supabase and returns a job_id immediately. The local openclaw-worker.js (running on the user\'s PC) processes the job with no timeout, so this works for jobs up to several hours. Poll with swipe_status until status=completed.',
    inputSchema: {
      type: 'object',
      properties: {
        source_url: { type: 'string', description: 'URL of the landing page to swipe' },
        product_name: { type: 'string' },
        product_id: { type: 'string', description: 'Alternative: use a saved product by ID instead of inline fields' },
        product_description: { type: 'string' },
        benefits: { type: 'string', description: 'Comma-separated benefits' },
        price: { type: 'string' },
        cta_text: { type: 'string' },
        cta_url: { type: 'string' },
        target_audience: { type: 'string' },
        brand_name: { type: 'string' },
        marketing_brief: { type: 'string', description: 'Positioning brief for inline swipe flows' },
        additional_marketing_notes: { type: 'string', description: 'Angles, proofs, objections, extra context' },
        tone: { type: 'string', description: 'professional, casual, urgent, luxury (default: professional)' },
        language: { type: 'string', description: 'it, en, es, de, fr (default: it)' },
      },
      required: ['source_url'],
    },
  },
  {
    name: 'swipe_status',
    description: 'Poll the status of any async swipe / long-running job started via *_async tools. Returns { status, progress?, response?, error? }. Status values: pending, processing, completed, error.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id returned by an *_async tool' },
        wait_seconds: { type: 'number', description: 'Optional: wait up to N seconds for completion before returning (max 250). Useful for "blocking poll".' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'list_swipe_jobs',
    description: 'List recent async swipe jobs and their statuses',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max jobs to return (default 20)' },
        status: { type: 'string', description: 'Optional filter: pending, processing, completed, error' },
      },
      required: [],
    },
  },
  {
    name: 'save_swiped_page',
    description: 'Save a swiped HTML page as a funnel page and optionally to the archive',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Page name' },
        html_content: { type: 'string', description: 'The swiped HTML content' },
        source_url: { type: 'string', description: 'Original source URL' },
        product_id: { type: 'string', description: 'Associated product ID' },
        page_type: { type: 'string', description: 'Page type: bridge, vsl, presell, squeeze, checkout, upsell, downsell, thank_you' },
        save_to_archive: { type: 'boolean', description: 'Also save to archive (default: true)' },
      },
      required: ['name', 'html_content'],
    },
  },
  {
    name: 'get_tool_status',
    description: 'Get the current status of the Funnel Swiper tool: counts of products, funnels, templates, archive entries',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ─── PROJECTS ───────────────────────────────────────────────────────
  {
    name: 'list_projects',
    description: 'List all projects (umbrella entities that group products, funnels, templates, archive)',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', description: 'Optional filter by status (active, archived, etc.)' } },
      required: [],
    },
  },
  {
    name: 'get_project',
    description: 'Get a single project with its associated funnel pages, templates, and archived funnels',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Project ID' } },
      required: ['id'],
    },
  },
  {
    name: 'create_project',
    description: 'Create a new project (or upsert if id is provided)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional id (upsert)' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', description: 'active, archived, draft (default active)' },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        domain: { type: 'object', description: 'Domain config object' },
        logo: { type: 'object', description: 'Logo config' },
        market_research: { type: 'object' },
        brief: { type: 'object' },
        front_end: { type: 'object' },
        back_end: { type: 'object' },
        compliance_funnel: { type: 'object' },
        funnel: { type: 'object' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_project',
    description: 'Update an existing project',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_project',
    description: 'Delete a project by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Project ID' } },
      required: ['id'],
    },
  },

  // ─── PROMPTS LIBRARY ─────────────────────────────────────────────────
  {
    name: 'list_prompts',
    description: 'List all saved AI prompts in the prompt library',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_prompt',
    description: 'Save a new prompt template to the library',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        category: { type: 'string', description: 'Category/section (copy, design, brief, etc.)' },
        content: { type: 'string', description: 'The prompt body' },
        variables: { type: 'array', items: { type: 'string' }, description: 'Variable names used in the prompt' },
        notes: { type: 'string' },
      },
      required: ['name', 'content'],
    },
  },

  // ─── SCHEDULED JOBS ─────────────────────────────────────────────────
  {
    name: 'list_scheduled_jobs',
    description: 'List all scheduled jobs (table: scheduled_browser_jobs — recurring browser-agent tasks)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_scheduled_job',
    description: 'Create a new scheduled browser-agent job (table: scheduled_browser_jobs). Required: template_id, title, prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'Browser-agent template ID (required)' },
        title: { type: 'string', description: 'Job title (required)' },
        prompt: { type: 'string', description: 'Agent prompt (required)' },
        start_url: { type: 'string' },
        max_turns: { type: 'number', description: 'Default 10' },
        category: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        frequency: { type: 'string', description: 'daily, weekly, hourly, etc.' },
        is_active: { type: 'boolean', description: 'Default true' },
        next_run_at: { type: 'string', description: 'ISO timestamp of next scheduled run' },
      },
      required: ['template_id', 'title', 'prompt'],
    },
  },
  {
    name: 'run_scheduled_jobs_now',
    description: 'Trigger the scheduled jobs runner immediately (run all due jobs)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ─── AI EDITING ──────────────────────────────────────────────────────
  {
    name: 'ai_edit_html',
    description: 'Use AI to modify a full HTML page based on a natural language instruction',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The HTML to modify' },
        instruction: { type: 'string', description: 'Natural language instruction (e.g. "change CTA color to red")' },
        productContext: { type: 'string', description: 'Optional product context for the AI' },
      },
      required: ['html', 'instruction'],
    },
  },
  {
    name: 'ai_edit_element',
    description: 'Use AI to modify a single HTML element',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The element HTML' },
        instruction: { type: 'string', description: 'What to change about this element' },
      },
      required: ['html', 'instruction'],
    },
  },
  {
    name: 'rewrite_section',
    description: 'Rewrite a single section of a landing page (headline, benefits, CTA, etc.) using AI',
    inputSchema: {
      type: 'object',
      properties: {
        sectionHtml: { type: 'string', description: 'The HTML of the section to rewrite' },
        sectionType: { type: 'string', description: 'Type: hero, benefits, testimonials, cta, faq, etc.' },
        product: { type: 'object', description: 'Product context (name, description, benefits, etc.)' },
        tone: { type: 'string', description: 'Copy tone (professional, casual, urgent, luxury)' },
        language: { type: 'string', description: 'Language code (it, en, es, de, fr)' },
      },
      required: ['sectionHtml'],
    },
  },

  // ─── QUIZ CREATOR ────────────────────────────────────────────────────
  {
    name: 'quiz_creator_analyze',
    description: 'Analyze a quiz landing page (screenshot + URL) to extract its structure for cloning',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        screenshot: { type: 'string', description: 'Base64-encoded screenshot (data URL or raw base64)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'quiz_creator_generate',
    description: 'Generate a pixel-perfect HTML clone of a quiz from screenshot + analysis',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        title: { type: 'string' },
        screenshot: { type: 'string' },
        analysis: { type: 'object' },
        phase: { type: 'string', description: 'generate or review (default generate)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'quiz_analyze',
    description: 'Analyze an existing quiz to extract questions, answers, and logic flow',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        html: { type: 'string', description: 'Optional pre-fetched HTML' },
      },
      required: [],
    },
  },

  // ─── SWIPE QUIZ ──────────────────────────────────────────────────────
  {
    name: 'swipe_quiz_generate',
    description: 'Swipe (clone + rewrite) an entire quiz funnel for a product',
    inputSchema: {
      type: 'object',
      properties: {
        sourceUrl: { type: 'string' },
        product: { type: 'object', description: 'Product object (name, description, benefits, etc.)' },
        tone: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['sourceUrl', 'product'],
    },
  },
  {
    name: 'swipe_quiz_multiagent_generate',
    description: 'Run the multi-agent swipe quiz pipeline (more thorough but slower)',
    inputSchema: {
      type: 'object',
      properties: {
        sourceUrl: { type: 'string' },
        product: { type: 'object' },
        productId: { type: 'string', description: 'Use a saved product by ID instead of inline product' },
      },
      required: ['sourceUrl'],
    },
  },

  // ─── FUNNEL ANALYZER ─────────────────────────────────────────────────
  {
    name: 'funnel_analyzer_crawl_start',
    description: 'Start a deep crawl of a funnel (returns jobId to poll)',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxPages: { type: 'number' },
      },
      required: ['url'],
    },
  },
  {
    name: 'funnel_analyzer_crawl_status',
    description: 'Get the status / partial results of a funnel crawl job',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'funnel_analyzer_save_steps',
    description: 'Save the discovered steps of a funnel crawl as funnel pages',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        productId: { type: 'string' },
        projectId: { type: 'string' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'funnel_analyzer_vision',
    description: 'Run vision AI on funnel pages to extract design tokens, structure, copy',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' } },
        screenshots: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
  },
  {
    name: 'funnel_analyze',
    description: 'High-level analysis of a single funnel URL (copy, structure, conversion elements)',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },

  // ─── REVERSE FUNNEL ──────────────────────────────────────────────────
  {
    name: 'reverse_funnel_analyze',
    description: 'Reverse-engineer a competitor funnel: ad → bridge → VSL → checkout',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        adCreative: { type: 'string', description: 'Optional ad creative URL or text' },
      },
      required: ['url'],
    },
  },
  {
    name: 'reverse_funnel_generate_visual',
    description: 'Generate a visual diagram of a reversed funnel structure',
    inputSchema: {
      type: 'object',
      properties: { funnelData: { type: 'object' } },
      required: ['funnelData'],
    },
  },

  // ─── BRANDING ────────────────────────────────────────────────────────
  {
    name: 'branding_generate',
    description: 'Generate a complete brand kit (logo, colors, fonts, tagline) for a product',
    inputSchema: {
      type: 'object',
      properties: {
        productName: { type: 'string' },
        productDescription: { type: 'string' },
        targetAudience: { type: 'string' },
        style: { type: 'string', description: 'modern, luxury, playful, minimal, etc.' },
      },
      required: ['productName'],
    },
  },

  // ─── COMPLIANCE ──────────────────────────────────────────────────────
  {
    name: 'compliance_check',
    description: 'Check a landing page or copy against ad-network compliance rules (Meta, Google, TikTok)',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string' },
        url: { type: 'string' },
        platform: { type: 'string', description: 'meta, google, tiktok' },
      },
      required: [],
    },
  },

  // ─── MEDIA / GENERATE ────────────────────────────────────────────────
  {
    name: 'generate_image',
    description: 'Generate an image with AI (logo, hero, product shot, banner)',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        style: { type: 'string' },
        size: { type: 'string', description: 'e.g. 1024x1024, 1792x1024' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'product_image_search',
    description: 'Search for product images on the web by name',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['query'],
    },
  },

  // ─── CATALOG IMPORT ──────────────────────────────────────────────────
  {
    name: 'catalog_import_parse',
    description: 'Parse a catalog file (Excel/CSV/JSON) into structured product data',
    inputSchema: {
      type: 'object',
      properties: {
        fileUrl: { type: 'string', description: 'URL of the catalog file (or base64 in fileData)' },
        fileData: { type: 'string', description: 'Base64-encoded file content' },
        format: { type: 'string', description: 'xlsx, csv, json' },
      },
      required: [],
    },
  },
  {
    name: 'catalog_import_enrich',
    description: 'Enrich parsed products with AI (descriptions, benefits, target audience, copy)',
    inputSchema: {
      type: 'object',
      properties: {
        products: { type: 'array', items: { type: 'object' } },
      },
      required: ['products'],
    },
  },

  // ─── PIPELINE (long-running jobs) ────────────────────────────────────
  {
    name: 'pipeline_start',
    description: 'Start a multi-step pipeline job (e.g. clone+rewrite+save+deploy)',
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'object' }, description: 'Array of step definitions' },
        params: { type: 'object', description: 'Initial pipeline parameters' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'pipeline_status',
    description: 'Get status of a pipeline job',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'pipeline_result',
    description: 'Get final result of a completed pipeline job',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'pipeline_jobs',
    description: 'List recent pipeline jobs',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ─── BRIEFS ──────────────────────────────────────────────────────────
  {
    name: 'funnel_brief_chat',
    description: 'Chat with the AI brief assistant to refine a funnel brief',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        history: { type: 'array', items: { type: 'object' } },
        productId: { type: 'string' },
      },
      required: ['message'],
    },
  },
  {
    name: 'briefs_sync',
    description: 'Sync briefs across products / funnels',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ─── FIRECRAWL ───────────────────────────────────────────────────────
  {
    name: 'firecrawl_crawl',
    description: 'Crawl a URL with Firecrawl (deep web scraping)',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        depth: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['url'],
    },
  },

  // ─── MEDIA UPLOAD ────────────────────────────────────────────────────
  {
    name: 'upload_media',
    description: 'Upload an image or media file (base64) to storage and get a public URL',
    inputSchema: {
      type: 'object',
      properties: {
        fileData: { type: 'string', description: 'Base64-encoded file content (or data URL)' },
        fileName: { type: 'string' },
        contentType: { type: 'string', description: 'e.g. image/png, image/jpeg' },
      },
      required: ['fileData'],
    },
  },
  {
    name: 'get_thumbnail',
    description: 'Get a screenshot thumbnail of a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        viewport: { type: 'string', description: 'desktop or mobile' },
      },
      required: ['url'],
    },
  },

  // ─── PROTOCOLLO VALCHIRIA ────────────────────────────────────────────
  {
    name: 'valchiria_list_swipe_funnels',
    description: 'List Protocollo Valchiria swipe funnels (archived funnels whose name contains [SWIPE]). Each contains a steps array with step_index/name/url_to_swipe/page_type/prompt.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'valchiria_get_swipe_funnel',
    description: 'Get a single Protocollo Valchiria swipe funnel with its full steps array',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Archived funnel ID' } },
      required: ['id'],
    },
  },
  {
    name: 'valchiria_create_swipe_funnel',
    description: 'Create a new Protocollo Valchiria swipe funnel (archived_funnels row with [SWIPE] in name). Real DB columns: name, total_steps (auto from steps.length), steps (JSON array), analysis (string, optional), section (default "valchiria"), project_id (optional). NO notes/url/html_content/page_type columns exist on archived_funnels.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Funnel name. [SWIPE] prefix is added automatically if missing.' },
        steps: {
          type: 'array',
          description: 'Array of step objects. Each step: { step_index, name, url_to_swipe, page_type, prompt, product_name? }',
          items: {
            type: 'object',
            properties: {
              step_index: { type: 'number' },
              name: { type: 'string' },
              url_to_swipe: { type: 'string' },
              page_type: { type: 'string', description: 'landing, advertorial, quiz_funnel, checkout, product_page, etc.' },
              prompt: { type: 'string', description: 'Custom rewrite prompt for this step' },
              product_name: { type: 'string' },
            },
          },
        },
        analysis: { type: 'string', description: 'Optional AI analysis summary' },
        section: { type: 'string', description: 'Optional section tag (default "valchiria")' },
        project_id: { type: 'string' },
      },
      required: ['name', 'steps'],
    },
  },
  {
    name: 'valchiria_update_swipe_funnel',
    description: 'Update a Protocollo Valchiria swipe funnel. Allowed columns only: name, steps, total_steps, analysis, section, project_id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        steps: { type: 'array', items: { type: 'object' } },
        total_steps: { type: 'number' },
        analysis: { type: 'string' },
        section: { type: 'string' },
        project_id: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'valchiria_add_step',
    description: 'Append a step to an existing Protocollo Valchiria swipe funnel. step_index is auto-assigned if not provided.',
    inputSchema: {
      type: 'object',
      properties: {
        funnel_id: { type: 'string', description: 'Archived funnel ID' },
        step_index: { type: 'number' },
        name: { type: 'string' },
        url_to_swipe: { type: 'string' },
        page_type: { type: 'string' },
        prompt: { type: 'string' },
        product_name: { type: 'string' },
      },
      required: ['funnel_id', 'name', 'url_to_swipe'],
    },
  },
  {
    name: 'valchiria_remove_step',
    description: 'Remove a step from a Protocollo Valchiria swipe funnel by its step_index',
    inputSchema: {
      type: 'object',
      properties: {
        funnel_id: { type: 'string' },
        step_index: { type: 'number' },
      },
      required: ['funnel_id', 'step_index'],
    },
  },
  {
    name: 'valchiria_delete_swipe_funnel',
    description: 'Delete a Protocollo Valchiria swipe funnel entirely',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'valchiria_load_steps_to_funnel',
    description: 'Main Protocollo Valchiria action: take selected steps from one or more swipe funnels and load them as funnel_pages for a target product. By default WIPES current funnel_pages first (matching the UI behavior). Each created funnel_page is set to swipe_status=pending so the Front End Funnel can swipe them.',
    inputSchema: {
      type: 'object',
      properties: {
        target_product_id: { type: 'string', description: 'Product ID the new funnel pages will be associated with' },
        selections: {
          type: 'array',
          description: 'List of {funnel_id, step_index} pairs to load',
          items: {
            type: 'object',
            properties: {
              funnel_id: { type: 'string' },
              step_index: { type: 'number' },
            },
            required: ['funnel_id', 'step_index'],
          },
        },
        wipe_existing: { type: 'boolean', description: 'Whether to delete existing funnel_pages first (default true, matches UI)' },
      },
      required: ['target_product_id', 'selections'],
    },
  },

  // ─── BROWSER AGENTICO ────────────────────────────────────────────────
  {
    name: 'browser_agentico_start',
    description: 'Start an agentic browser session that navigates a URL and performs an action (e.g. extract, scroll, click)',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        instruction: { type: 'string' },
        maxSteps: { type: 'number' },
      },
      required: ['url', 'instruction'],
    },
  },
  {
    name: 'browser_agentico_status',
    description: 'Get status / partial result of a running browser-agentico job',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },

  // ─── AGENTIC ─────────────────────────────────────────────────────────
  {
    name: 'agentic_extract',
    description: 'Use the agentic extractor to pull structured data (text, images, prices) from a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        schema: { type: 'object', description: 'Optional JSON schema for what to extract' },
      },
      required: ['url'],
    },
  },
  {
    name: 'agentic_scrape',
    description: 'Scrape a URL with the agentic scraper (returns markdown + metadata)',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'agentic_analyze',
    description: 'Run agentic analysis on a URL or HTML',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        html: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'agentic_vision',
    description: 'Run agentic vision analysis on a screenshot or URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        screenshot: { type: 'string', description: 'Base64 or data URL' },
        instruction: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'agentic_health',
    description: 'Health check for agentic services',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'agentic_swipe',
    description: 'Run the autonomous Agentic Swipe pipeline that swipes a competitor funnel end-to-end for a product',
    inputSchema: {
      type: 'object',
      properties: {
        sourceUrl: { type: 'string' },
        productId: { type: 'string' },
        product: { type: 'object' },
        tone: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['sourceUrl'],
    },
  },

  // ─── DEPLOY ──────────────────────────────────────────────────────────
  {
    name: 'deploy_funnelish',
    description: 'Deploy a funnel page to Funnelish',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string' },
        funnelName: { type: 'string' },
        productId: { type: 'string' },
        pageType: { type: 'string' },
      },
      required: ['html'],
    },
  },
  {
    name: 'deploy_checkout_champ',
    description: 'Deploy a funnel to Checkout Champ',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string' },
        funnelName: { type: 'string' },
        productId: { type: 'string' },
        pageType: { type: 'string' },
      },
      required: ['html'],
    },
  },
  {
    name: 'deploy_checkout_champ_tracking',
    description: 'Set / update Checkout Champ tracking config',
    inputSchema: {
      type: 'object',
      properties: {
        funnelId: { type: 'string' },
        trackingConfig: { type: 'object' },
      },
      required: ['funnelId'],
    },
  },

  // ─── VISION JOBS ─────────────────────────────────────────────────────
  {
    name: 'list_vision_jobs',
    description: 'List vision analysis jobs',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_vision_job',
    description: 'Get a vision job by ID with its result',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },

  // ─── CURSOR AGENTS ───────────────────────────────────────────────────
  {
    name: 'list_cursor_agents',
    description: 'List Cursor coding-agent sessions',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_cursor_agent',
    description: 'Spawn a new Cursor coding-agent task',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' },
        model: { type: 'string' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'cursor_agent_followup',
    description: 'Send a follow-up message to a Cursor coding-agent session',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cursor agent session ID' },
        message: { type: 'string' },
      },
      required: ['id', 'message'],
    },
  },

  // ─── AFFILIATE ───────────────────────────────────────────────────────
  {
    name: 'affiliate_save_funnel',
    description: 'Save a discovered affiliate funnel from the Affiliate Browser Chat',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        url: { type: 'string' },
        offer: { type: 'object' },
        steps: { type: 'array' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },

  // ─── GENERATE QUIZ ───────────────────────────────────────────────────
  {
    name: 'generate_quiz',
    description: 'Generate a quiz funnel from scratch given a topic / product',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        productId: { type: 'string' },
        questions: { type: 'number' },
        style: { type: 'string' },
      },
      required: [],
    },
  },

  // ─── GENERIC DATABASE ACCESS ─────────────────────────────────────────
  {
    name: 'db_list_tables',
    description: 'List all Supabase tables the MCP can read/write directly via db_select / db_insert / db_update / db_delete.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'db_select',
    description: 'Read rows from any Supabase table with optional filters / ordering / pagination. Escape hatch for everything not covered by named tools.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (call db_list_tables to discover)' },
        columns: { type: 'string', description: 'Comma-separated columns or "*" (default *)' },
        filters: {
          type: 'object',
          description: 'Equality filters as { col: value }. For advanced filters use op-prefixed values: { col: "ilike:%foo%" }, { col: "gt:100" }, { col: "in:1,2,3" }',
        },
        orderBy: { type: 'string', description: 'Column name (default created_at)' },
        ascending: { type: 'boolean', description: 'default false' },
        limit: { type: 'number', description: 'max rows (default 100, hard cap 1000)' },
        offset: { type: 'number' },
      },
      required: ['table'],
    },
  },
  {
    name: 'db_insert',
    description: 'Insert a row (or rows) into any Supabase table',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        data: { description: 'Row object or array of rows' },
      },
      required: ['table', 'data'],
    },
  },
  {
    name: 'db_update',
    description: 'Update rows in any Supabase table by equality filter',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        filters: { type: 'object', description: 'Equality filters (e.g. { id: "..." })' },
        data: { type: 'object', description: 'Fields to update' },
      },
      required: ['table', 'filters', 'data'],
    },
  },
  {
    name: 'db_delete',
    description: 'Delete rows from any Supabase table by equality filter',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        filters: { type: 'object', description: 'Equality filters (e.g. { id: "..." })' },
      },
      required: ['table', 'filters'],
    },
  },

  // ─── DISCOVERY ───────────────────────────────────────────────────────
  {
    name: 'list_sections',
    description: 'List all UI sections (pages) of the tool with their purpose. Use this to understand the full surface area available.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_api_endpoints',
    description: 'List ALL internal API endpoints of the tool with their methods and a short description. Use this to discover what invoke_api can call.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ─── CHECKPOINT (qualitative funnel audit) ───────────────────────────
  // Surface the Checkpoint feature to external auditors (eg. OpenClaw)
  // so they can either trigger the built-in Claude pipeline OR fetch
  // raw page contents and run their own analysis, then write the
  // result back via checkpoint_save_run so it shows up in the dashboard
  // exactly like a Claude run.
  {
    name: 'checkpoint_list_funnels',
    description: 'List every funnel registered in the Checkpoint library, newest first. Optionally filter by projectId.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'checkpoint_get_funnel',
    description: 'Get a single Checkpoint funnel by id, plus its run history (newest 20).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'checkpoint_create_funnel',
    description: 'Add a new funnel to the Checkpoint library. Pass `pages: [{url, name?}]` for multi-step funnels OR `url` for a single-page audit.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional display name. Defaults to the first page hostname.' },
        url: { type: 'string', description: 'Single-page funnel — first/only URL. Use `pages` for multi-step.' },
        pages: {
          type: 'array',
          description: 'Ordered steps of the funnel. Up to 100 pages.',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              name: { type: 'string' },
            },
            required: ['url'],
          },
        },
        notes: { type: 'string' },
        brand_profile: { type: 'string', description: 'Brand voice profile used by the Tone of Voice category.' },
        product_type: { type: 'string', enum: ['supplement', 'digital', 'both'] },
        project_id: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'checkpoint_delete_funnel',
    description: 'Delete a Checkpoint funnel and cascade its run history.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'checkpoint_run_start',
    description: 'Trigger an audit on a funnel. With the default `auditor: "claude"` this BLOCKS until the run completes (built-in Anthropic pipeline, capped by the platform timeout). With `auditor: "openclaw:neo"` or `"openclaw:morfeo"` the work is enqueued for the SPECIFIC OpenClaw worker (target_agent routing — Neo and Morfeo never race on the same job) and the call returns IMMEDIATELY with the runId; poll checkpoint_run_status to watch the per-category results stream in.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Funnel id from checkpoint_list_funnels.' },
        categories: {
          type: 'array',
          description: 'Categories to run. Defaults to ["navigation","coherence","copy"].',
          items: { type: 'string', enum: ['navigation', 'coherence', 'copy', 'cro', 'tov', 'compliance'] },
        },
        brandProfile: { type: 'string' },
        triggeredByName: { type: 'string', description: 'Name shown in the Log modal — defaults to the API key label.' },
        auditor: {
          type: 'string',
          description: 'Who runs the audit. "claude" = built-in Anthropic, blocking. "openclaw:neo" / "openclaw:morfeo" = enqueue for that specific local worker via openclaw_messages.target_agent (non-blocking, returns the runId immediately).',
          enum: ['claude', 'openclaw:neo', 'openclaw:morfeo'],
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'checkpoint_run_status',
    description: 'Poll a single run by runId. While the run is in progress the JSONB `results` column streams partial categories (one per ~30s). Auto-marks the run as failed if it has been stuck in `running` for >10 minutes.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
    },
  },
  {
    name: 'checkpoint_latest_run',
    description: 'Get the most recent run for a funnel — useful right after kicking off a run when you only have the funnel id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Funnel id.' } },
      required: ['id'],
    },
  },
  {
    name: 'checkpoint_recent_logs',
    description: 'Global log: every Checkpoint run executed across all funnels, newest first (default cap 200).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
      required: [],
    },
  },
  {
    name: 'checkpoint_fetch_pages',
    description: 'Fetch the LIVE contents of every page in a funnel — HTML and/or audit-friendly text — so an external auditor (OpenClaw, etc.) can do its OWN analysis in-context. Honours SPA rendering via Playwright. Mode: "text" (default, ~30KB/page), "html" (raw, capped), or "both".',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Funnel id.' },
        mode: { type: 'string', enum: ['text', 'html', 'both'], description: 'Default: text.' },
        maxCharsPerPage: { type: 'number', description: 'Per-page cap. Default 30000, max 200000.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'checkpoint_save_run',
    description: 'Save an EXTERNAL audit result back into the funnel_checkpoints table — the run shows up in the dashboard exactly like a built-in Claude run. Use this AFTER checkpoint_fetch_pages once your own analysis is done. The score columns and overall score are recomputed server-side from `results`, so you only ship the per-category payload.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Funnel id.' },
        results: {
          type: 'object',
          description: 'Per-category audit output: { navigation?: {...}, coherence?: {...}, copy?: {...} }. Each category has shape { score: 0-100|null, status: "pass"|"warn"|"fail"|"error"|"skipped", summary, issues: [...], suggestions: [...] }.',
        },
        status: { type: 'string', enum: ['completed', 'partial', 'failed'] },
        triggeredByName: { type: 'string', description: 'Auditor name shown in the Log modal — eg. "OpenClaw / Neo".' },
        triggeredByUserId: { type: 'string' },
        error: { type: 'string', description: 'Surface only when status="failed".' },
      },
      required: ['id', 'results'],
    },
  },

  // ─── GENERIC ESCAPE HATCH ────────────────────────────────────────────
  {
    name: 'invoke_api',
    description: 'Generic call to any internal /api/* endpoint of the tool. Use this when no specific MCP tool covers what you need. Inspect available endpoints with list_api_endpoints first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Endpoint path starting with /api/ (e.g. /api/quiz-creator/generate)' },
        method: { type: 'string', description: 'HTTP method: GET, POST, PUT, DELETE, PATCH (default POST)' },
        body: { type: 'object', description: 'JSON body for POST/PUT/PATCH' },
        query: { type: 'object', description: 'Query string parameters as key/value' },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (default 180000, max 600000)' },
      },
      required: ['path'],
    },
  },
];

async function validateMcpAuth(req: NextRequest): Promise<{ valid: boolean; error?: string }> {
  const apiKey = req.headers.get('x-api-key') || req.headers.get('authorization')?.replace('Bearer ', '');
  if (!apiKey || !apiKey.startsWith('fsk_')) {
    return { valid: false, error: 'Missing or invalid API key. Use X-API-Key header with an fsk_ key.' };
  }
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, permissions, is_active, expires_at')
    .eq('key_hash', keyHash)
    .single();

  if (error || !data) return { valid: false, error: 'Invalid API key.' };
  if (!data.is_active) return { valid: false, error: 'API key is disabled.' };
  if (data.expires_at && new Date(data.expires_at) < new Date()) return { valid: false, error: 'API key expired.' };

  const perms = data.permissions || [];
  if (!perms.includes('full_access')) return { valid: false, error: 'MCP requires full_access permission.' };

  supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(() => {});
  return { valid: true };
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_products': {
      const { data, error } = await supabase.from('products').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return { products: data, count: data?.length || 0 };
    }
    case 'create_product': {
      const { data, error } = await supabase.from('products').insert(args).select().single();
      if (error) throw new Error(error.message);
      return { product: data };
    }
    case 'update_product': {
      const { id, ...updates } = args;
      const { data, error } = await supabase.from('products').update(updates).eq('id', id).select().single();
      if (error) throw new Error(error.message);
      return { product: data };
    }
    case 'delete_product': {
      const { error } = await supabase.from('products').delete().eq('id', args.id);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    case 'get_product': {
      const { data, error } = await supabase.from('products').select('*').eq('id', args.id).single();
      if (error) throw new Error(error.message);
      return { product: data };
    }
    case 'search_products': {
      const q = String(args.query).toLowerCase();
      const { data, error } = await supabase.from('products').select('*').or(`name.ilike.%${q}%,description.ilike.%${q}%`);
      if (error) throw new Error(error.message);
      return { products: data, count: data?.length || 0 };
    }
    case 'list_funnels': {
      const { data, error } = await supabase.from('funnel_pages').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return { funnels: data, count: data?.length || 0 };
    }
    case 'create_funnel_page': {
      const { data, error } = await supabase.from('funnel_pages').insert(args).select().single();
      if (error) throw new Error(error.message);
      return { funnel_page: data };
    }
    case 'update_funnel_page': {
      const { id, ...updates } = args;
      const { data, error } = await supabase.from('funnel_pages').update(updates).eq('id', id).select().single();
      if (error) throw new Error(error.message);
      return { funnel_page: data };
    }
    case 'delete_funnel_page': {
      const { error } = await supabase.from('funnel_pages').delete().eq('id', args.id);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    case 'get_funnel_page': {
      const { data, error } = await supabase.from('funnel_pages').select('*').eq('id', args.id).single();
      if (error) throw new Error(error.message);
      return { funnel_page: data };
    }
    case 'list_templates': {
      const { data, error } = await supabase.from('swipe_templates').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return { templates: data, count: data?.length || 0 };
    }
    case 'get_template': {
      const { data, error } = await supabase.from('swipe_templates').select('*').eq('id', args.id).single();
      if (error) throw new Error(error.message);
      return { template: data };
    }
    case 'create_template': {
      const { data, error } = await supabase.from('swipe_templates').insert(args).select().single();
      if (error) throw new Error(error.message);
      return { template: data };
    }
    case 'update_template': {
      const { id, ...updates } = args;
      const { data, error } = await supabase.from('swipe_templates').update(updates).eq('id', id).select().single();
      if (error) throw new Error(error.message);
      return { template: data };
    }
    case 'delete_template': {
      const { error } = await supabase.from('swipe_templates').delete().eq('id', args.id);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    case 'list_archive': {
      const { data, error } = await supabase.from('archived_funnels').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return { archived_funnels: data, count: data?.length || 0 };
    }
    case 'get_archive_entry': {
      const { data, error } = await supabase.from('archived_funnels').select('*').eq('id', args.id).single();
      if (error) throw new Error(error.message);
      return { archived_funnel: data };
    }
    case 'create_archive_entry': {
      const stepsArr = Array.isArray(args.steps) ? args.steps : [];
      const insert: Record<string, unknown> = {
        name: args.name,
        steps: stepsArr,
        total_steps: typeof args.total_steps === 'number' ? args.total_steps : stepsArr.length,
      };
      if (args.analysis !== undefined) insert.analysis = args.analysis;
      if (args.section !== undefined) insert.section = args.section;
      if (args.project_id !== undefined) insert.project_id = args.project_id;
      const { data, error } = await supabase.from('archived_funnels').insert(insert).select().single();
      if (error) throw new Error(error.message);
      return { archived_funnel: data };
    }
    case 'update_archive_entry': {
      const allowed = ['name', 'steps', 'total_steps', 'analysis', 'section', 'project_id'];
      const updates: Record<string, unknown> = {};
      for (const k of allowed) {
        if (args[k] !== undefined) updates[k] = args[k];
      }
      // Auto-recompute total_steps if steps was provided but total_steps wasn't
      if (Array.isArray(args.steps) && args.total_steps === undefined) {
        updates.total_steps = (args.steps as unknown[]).length;
      }
      const { data, error } = await supabase.from('archived_funnels').update(updates).eq('id', args.id).select().single();
      if (error) throw new Error(error.message);
      return { archived_funnel: data };
    }
    case 'delete_archive_entry': {
      const { error } = await supabase.from('archived_funnels').delete().eq('id', args.id);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    case 'analyze_copy': {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://cloner-funnel-builder.vercel.app';
      const res = await fetch(`${baseUrl}/api/analyze-copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: args.url }),
      });
      return await res.json();
    }
    case 'clone_landing_page': {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://cloner-funnel-builder.vercel.app';
      const res = await fetch(`${baseUrl}/api/landing/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: args.url }),
      });
      return await res.json();
    }
    case 'send_openclaw_message': {
      const { data, error } = await supabase
        .from('openclaw_messages')
        .insert({
          user_message: args.message,
          section: (args.section as string) || 'MCP',
          status: 'pending',
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);

      const msgId = data.id;
      for (let i = 0; i < 200; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const { data: poll } = await supabase
          .from('openclaw_messages')
          .select('status, response, error_message')
          .eq('id', msgId)
          .single();
        if (poll?.status === 'completed') return { response: poll.response };
        if (poll?.status === 'error') throw new Error(poll.error_message || 'OpenClaw error');
      }
      throw new Error('OpenClaw timeout');
    }
    case 'generate_product_brief': {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://cloner-funnel-builder.vercel.app';
      const res = await fetch(`${baseUrl}/api/product-brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName: args.product_name,
          productDescription: args.product_description || '',
          targetAudience: args.target_audience || '',
        }),
      });
      return await res.json();
    }
    case 'list_api_keys': {
      const { data, error } = await supabase
        .from('api_keys')
        .select('id, name, description, key_prefix, permissions, is_active, last_used_at, created_at')
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return { api_keys: data, count: data?.length || 0 };
    }
    case 'crawl_funnel': {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://cloner-funnel-builder.vercel.app';
      const res = await fetch(`${baseUrl}/api/funnel-analyzer/crawl/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: args.url, maxPages: args.max_pages || 10 }),
      });
      return await res.json();
    }
    case 'swipe_landing_page': {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://cloner-funnel-builder.vercel.app';
      const product: Record<string, unknown> = { name: args.product_name };
      if (args.product_description) product.description = args.product_description;
      if (args.benefits) product.benefits = String(args.benefits).split(',').map((b: string) => b.trim());
      if (args.price) product.price = args.price;
      if (args.cta_text) product.cta_text = args.cta_text;
      if (args.cta_url) product.cta_url = args.cta_url;
      if (args.target_audience) product.target_audience = args.target_audience;
      if (args.brand_name) product.brand_name = args.brand_name;
      if (typeof args.marketing_brief === 'string' && args.marketing_brief.trim()) {
        product.marketing_brief = args.marketing_brief.trim();
      }
      if (typeof args.additional_marketing_notes === 'string' && args.additional_marketing_notes.trim()) {
        product.additional_marketing_notes = args.additional_marketing_notes.trim();
      }
      const res = await fetch(`${baseUrl}/api/landing/swipe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: args.source_url,
          product,
          tone: args.tone || 'professional',
          language: args.language || 'it',
        }),
        signal: AbortSignal.timeout(290_000),
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      return {
        success: true,
        html_length: result.html?.length || 0,
        original_title: result.original_title,
        new_title: result.new_title,
        total_texts: result.totalTexts,
        replacements: result.replacements,
        unresolved_text_ids: result.unresolved_text_ids ?? [],
        coverage_ratio: result.coverage_ratio,
        provider: result.provider,
        changes: result.changes_made,
        html: result.html,
      };
    }
    case 'swipe_landing_for_product_id': {
      const { data: prod, error: prodErr } = await supabase.from('products').select('*').eq('id', args.product_id).single();
      if (prodErr || !prod) throw new Error(`Product not found: ${args.product_id}`);
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://cloner-funnel-builder.vercel.app';
      const productPayload = await buildSwipeProductPayload(prod as CatalogProductRow, {
        productIdForProjects: String(args.product_id),
        marketing_brief: typeof args.marketing_brief === 'string' ? args.marketing_brief : undefined,
        additional_marketing_notes:
          typeof args.additional_marketing_notes === 'string' ? args.additional_marketing_notes : undefined,
      });
      const res = await fetch(`${baseUrl}/api/landing/swipe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: args.source_url,
          product: productPayload,
          tone: args.tone || 'professional',
          language: args.language || 'it',
        }),
        signal: AbortSignal.timeout(290_000),
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      return {
        success: true,
        product_used: prod.name,
        html_length: result.html?.length || 0,
        original_title: result.original_title,
        new_title: result.new_title,
        total_texts: result.totalTexts,
        replacements: result.replacements,
        unresolved_text_ids: result.unresolved_text_ids ?? [],
        coverage_ratio: result.coverage_ratio,
        provider: result.provider,
        changes: result.changes_made,
        html: result.html,
      };
    }
    case 'swipe_landing_page_async': {
      // Resolve product (either by id or from inline fields)
      let product: Record<string, unknown>;
      if (args.product_id) {
        const { data: prod, error: prodErr } = await supabase
          .from('products').select('*').eq('id', args.product_id).single();
        if (prodErr || !prod) throw new Error(`Product not found: ${args.product_id}`);
        product = await buildSwipeProductPayload(prod as CatalogProductRow, {
          productIdForProjects: String(args.product_id),
          marketing_brief: typeof args.marketing_brief === 'string' ? args.marketing_brief : undefined,
          additional_marketing_notes:
            typeof args.additional_marketing_notes === 'string' ? args.additional_marketing_notes : undefined,
        });
      } else {
        if (!args.product_name) throw new Error('Either product_id or product_name is required');
        product = { name: String(args.product_name) };
        if (args.product_description) product.description = args.product_description;
        if (args.benefits) product.benefits = String(args.benefits).split(',').map((b: string) => b.trim());
        if (args.price) product.price = args.price;
        if (args.cta_text) product.cta_text = args.cta_text;
        if (args.cta_url) product.cta_url = args.cta_url;
        if (args.target_audience) product.target_audience = args.target_audience;
        if (args.brand_name) product.brand_name = args.brand_name;
        if (typeof args.marketing_brief === 'string' && args.marketing_brief.trim()) {
          product.marketing_brief = args.marketing_brief.trim();
        }
        if (typeof args.additional_marketing_notes === 'string' && args.additional_marketing_notes.trim()) {
          product.additional_marketing_notes = args.additional_marketing_notes.trim();
        }
      }

      const jobPayload = {
        action: 'swipe_landing_page',
        source_url: args.source_url,
        product,
        tone: args.tone || 'professional',
        language: args.language || 'it',
      };

      const { data: msg, error } = await supabase
        .from('openclaw_messages')
        .insert({
          user_message: JSON.stringify(jobPayload),
          section: 'swipe_job',
          status: 'pending',
        })
        .select('id, created_at')
        .single();
      if (error) throw new Error(error.message);

      return {
        job_id: msg.id,
        status: 'pending',
        created_at: msg.created_at,
        notes: 'Poll with swipe_status (or list_swipe_jobs). The local openclaw-worker.js must be running with swipe_job handler enabled.',
      };
    }

    case 'swipe_status': {
      const jobId = String(args.job_id);
      const waitMs = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), 250) * 1000;
      const start = Date.now();

      do {
        const { data, error } = await supabase
          .from('openclaw_messages')
          .select('id, status, response, error_message, section, created_at, completed_at')
          .eq('id', jobId)
          .single();
        if (error) throw new Error(error.message);
        if (!data) throw new Error('Job not found');

        const elapsedMs = Date.now() - start;

        if (data.status === 'completed') {
          let parsedResponse: unknown = data.response;
          try { parsedResponse = JSON.parse(String(data.response)); } catch { /* keep raw */ }
          return {
            job_id: data.id,
            status: 'completed',
            response: parsedResponse,
            section: data.section,
            elapsed_ms: elapsedMs,
            completed_at: data.completed_at,
          };
        }
        if (data.status === 'error') {
          return {
            job_id: data.id,
            status: 'error',
            error: data.error_message,
            section: data.section,
            elapsed_ms: elapsedMs,
          };
        }
        if (waitMs > 0 && elapsedMs < waitMs) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        return {
          job_id: data.id,
          status: data.status,
          section: data.section,
          created_at: data.created_at,
          elapsed_ms: elapsedMs,
          notes: 'Job not yet completed. Call swipe_status again or pass wait_seconds for a blocking poll.',
        };
      } while (true);
    }

    case 'list_swipe_jobs': {
      const limit = Math.min(Number(args.limit) || 20, 100);
      let q = supabase
        .from('openclaw_messages')
        .select('id, status, section, created_at, completed_at, error_message')
        .eq('section', 'swipe_job')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (args.status) q = q.eq('status', String(args.status));
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return { jobs: data, count: data?.length || 0 };
    }

    case 'save_swiped_page': {
      const { data: fp, error: fpErr } = await supabase.from('funnel_pages').insert({
        name: args.name,
        html_content: args.html_content,
        url: args.source_url || '',
        page_type: args.page_type || 'bridge',
        product_id: args.product_id || null,
      }).select().single();
      if (fpErr) throw new Error(fpErr.message);

      let archiveResult = null;
      if (args.save_to_archive !== false) {
        const { data: ar } = await supabase.from('archived_funnels').insert({
          name: args.name,
          html_content: args.html_content,
          url: args.source_url || '',
          page_type: args.page_type || 'bridge',
        }).select().single();
        archiveResult = ar;
      }
      return { funnel_page: fp, archived: !!archiveResult, archive_id: archiveResult?.id };
    }
    case 'get_tool_status': {
      const [products, funnels, templates, archive] = await Promise.all([
        supabase.from('products').select('id', { count: 'exact', head: true }),
        supabase.from('funnel_pages').select('id', { count: 'exact', head: true }),
        supabase.from('swipe_templates').select('id', { count: 'exact', head: true }),
        supabase.from('archived_funnels').select('id', { count: 'exact', head: true }),
      ]);
      return {
        products: products.count || 0,
        funnels: funnels.count || 0,
        templates: templates.count || 0,
        archived_funnels: archive.count || 0,
        status: 'online',
      };
    }

    // ─── PROJECTS ──────────────────────────────────────────────────────
    case 'list_projects': {
      let q = supabase.from('projects').select('*').order('created_at', { ascending: false });
      if (args.status) q = q.eq('status', args.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return { projects: data, count: data?.length || 0 };
    }
    case 'get_project': {
      const { data, error } = await supabase.from('projects').select('*').eq('id', args.id).single();
      if (error) throw new Error(error.message);
      const [funnelPages, templates, archives] = await Promise.all([
        supabase.from('funnel_pages').select('*').eq('project_id', args.id),
        supabase.from('swipe_templates').select('*').eq('project_id', args.id),
        supabase.from('archived_funnels').select('*').eq('project_id', args.id),
      ]);
      return {
        project: data,
        funnel_pages: funnelPages.data || [],
        templates: templates.data || [],
        archived_funnels: archives.data || [],
      };
    }
    case 'create_project': {
      const { id, ...rest } = args;
      const insert: Record<string, unknown> = { ...rest, status: rest.status || 'active' };
      if (id) {
        insert.id = id;
        const { data, error } = await supabase.from('projects').upsert(insert, { onConflict: 'id' }).select().single();
        if (error) throw new Error(error.message);
        return { project: data };
      }
      const { data, error } = await supabase.from('projects').insert(insert).select().single();
      if (error) throw new Error(error.message);
      return { project: data };
    }
    case 'update_project': {
      const { id, ...updates } = args;
      const { data, error } = await supabase.from('projects').update(updates).eq('id', id).select().single();
      if (error) throw new Error(error.message);
      return { project: data };
    }
    case 'delete_project': {
      const { error } = await supabase.from('projects').delete().eq('id', args.id);
      if (error) throw new Error(error.message);
      return { success: true };
    }

    // ─── PROMPTS (saved_prompts table) ─────────────────────────────────
    case 'list_prompts': {
      const { data, error } = await supabase.from('saved_prompts').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return { prompts: data, count: data?.length || 0 };
    }
    case 'create_prompt': {
      const insert = {
        title: args.name || args.title,
        content: args.content,
        category: args.category || 'general',
        tags: args.variables || args.tags || [],
        is_favorite: false,
      };
      const { data, error } = await supabase.from('saved_prompts').insert(insert).select().single();
      if (error) throw new Error(error.message);
      return { prompt: data };
    }

    // ─── SCHEDULED JOBS (scheduled_browser_jobs table) ─────────────────
    case 'list_scheduled_jobs': {
      const { data, error } = await supabase.from('scheduled_browser_jobs').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return { jobs: data, count: data?.length || 0 };
    }
    case 'create_scheduled_job': {
      const allowed = ['template_id', 'title', 'prompt', 'start_url', 'max_turns', 'category', 'tags', 'frequency', 'is_active', 'next_run_at'];
      const insert: Record<string, unknown> = {};
      for (const k of allowed) if (args[k] !== undefined) insert[k] = args[k];
      if (insert.is_active === undefined) insert.is_active = true;
      const { data, error } = await supabase.from('scheduled_browser_jobs').insert(insert).select().single();
      if (error) throw new Error(error.message);
      return { job: data };
    }
    case 'run_scheduled_jobs_now': {
      return await proxyApiCall('GET', '/api/scheduled-jobs/cron', {}, {}, 60_000);
    }

    // ─── AI EDITING ────────────────────────────────────────────────────
    case 'ai_edit_html':
      return await proxyApiCall('POST', '/api/ai-edit-html', args, {}, 180_000);
    case 'ai_edit_element':
      return await proxyApiCall('POST', '/api/ai-edit-element', args, {}, 60_000);
    case 'rewrite_section':
      return await proxyApiCall('POST', '/api/rewrite-section', args, {}, 120_000);

    // ─── QUIZ CREATOR ──────────────────────────────────────────────────
    case 'quiz_creator_analyze':
      return await proxyApiCall('POST', '/api/quiz-creator/analyze', args, {}, 180_000);
    case 'quiz_creator_generate':
      return await proxyApiCall('POST', '/api/quiz-creator/generate', args, {}, 300_000);
    case 'quiz_analyze':
      return await proxyApiCall('POST', '/api/quiz/analyze', args, {}, 120_000);

    // ─── SWIPE QUIZ ────────────────────────────────────────────────────
    case 'swipe_quiz_generate':
      return await proxyApiCall('POST', '/api/swipe-quiz/generate', args, {}, 300_000);
    case 'swipe_quiz_multiagent_generate':
      return await proxyApiCall('POST', '/api/swipe-quiz/multiagent-generate', args, {}, 300_000);

    // ─── FUNNEL ANALYZER ───────────────────────────────────────────────
    case 'funnel_analyzer_crawl_start':
      return await proxyApiCall('POST', '/api/funnel-analyzer/crawl/start', { url: args.url, maxPages: args.maxPages || 10 }, {}, 60_000);
    case 'funnel_analyzer_crawl_status':
      return await proxyApiCall('GET', `/api/funnel-analyzer/crawl/status/${args.jobId}`, {}, {}, 30_000);
    case 'funnel_analyzer_save_steps':
      return await proxyApiCall('POST', '/api/funnel-analyzer/save-steps', args, {}, 60_000);
    case 'funnel_analyzer_vision':
      return await proxyApiCall('POST', '/api/funnel-analyzer/vision', args, {}, 180_000);
    case 'funnel_analyze':
      return await proxyApiCall('POST', '/api/funnel/analyze', args, {}, 180_000);

    // ─── REVERSE FUNNEL ────────────────────────────────────────────────
    case 'reverse_funnel_analyze':
      return await proxyApiCall('POST', '/api/reverse-funnel/analyze', args, {}, 180_000);
    case 'reverse_funnel_generate_visual':
      return await proxyApiCall('POST', '/api/reverse-funnel/generate-visual', args, {}, 60_000);

    // ─── BRANDING ──────────────────────────────────────────────────────
    case 'branding_generate':
      return await proxyApiCall('POST', '/api/branding/generate', args, {}, 180_000);

    // ─── COMPLIANCE ────────────────────────────────────────────────────
    case 'compliance_check':
      return await proxyApiCall('POST', '/api/compliance-ai', args, {}, 120_000);

    // ─── MEDIA / GENERATE ──────────────────────────────────────────────
    case 'generate_image':
      return await proxyApiCall('POST', '/api/generate-image', args, {}, 120_000);
    case 'product_image_search':
      return await proxyApiCall('POST', '/api/product-image-search', args, {}, 60_000);

    // ─── CATALOG IMPORT ────────────────────────────────────────────────
    case 'catalog_import_parse':
      return await proxyApiCall('POST', '/api/catalog-import/parse', args, {}, 120_000);
    case 'catalog_import_enrich':
      return await proxyApiCall('POST', '/api/catalog-import/enrich', args, {}, 240_000);

    // ─── PIPELINE ──────────────────────────────────────────────────────
    case 'pipeline_start':
      return await proxyApiCall('POST', '/api/pipeline/start', args, {}, 60_000);
    case 'pipeline_status':
      return await proxyApiCall('GET', `/api/pipeline/status/${args.jobId}`, {}, {}, 30_000);
    case 'pipeline_result':
      return await proxyApiCall('GET', `/api/pipeline/result/${args.jobId}`, {}, {}, 30_000);
    case 'pipeline_jobs':
      return await proxyApiCall('GET', '/api/pipeline/jobs', {}, {}, 30_000);

    // ─── BRIEFS ────────────────────────────────────────────────────────
    case 'funnel_brief_chat':
      return await proxyApiCall('POST', '/api/funnel-brief/chat', args, {}, 120_000);
    case 'briefs_sync':
      return await proxyApiCall('POST', '/api/briefs-sync', args, {}, 60_000);

    // ─── FIRECRAWL ─────────────────────────────────────────────────────
    case 'firecrawl_crawl':
      return await proxyApiCall('POST', '/api/firecrawl', args, {}, 240_000);

    // ─── MEDIA UPLOAD ──────────────────────────────────────────────────
    case 'upload_media':
      return await proxyApiCall('POST', '/api/upload-media', args, {}, 120_000);
    case 'get_thumbnail':
      return await proxyApiCall('GET', '/api/thumbnail', {}, { url: String(args.url), viewport: String(args.viewport || 'desktop') }, 60_000);

    // ─── PROTOCOLLO VALCHIRIA ──────────────────────────────────────────
    case 'valchiria_list_swipe_funnels': {
      const { data, error } = await supabase
        .from('archived_funnels')
        .select('*')
        .ilike('name', '%[SWIPE]%')
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return { swipe_funnels: data, count: data?.length || 0 };
    }
    case 'valchiria_get_swipe_funnel': {
      const { data, error } = await supabase
        .from('archived_funnels')
        .select('*')
        .eq('id', args.id)
        .single();
      if (error) throw new Error(error.message);
      return { swipe_funnel: data };
    }
    case 'valchiria_create_swipe_funnel': {
      const rawName = String(args.name || '');
      const name = rawName.includes('[SWIPE]') ? rawName : `[SWIPE] ${rawName}`;
      const stepsArr = Array.isArray(args.steps) ? args.steps : [];
      const insert: Record<string, unknown> = {
        name,
        steps: stepsArr,
        total_steps: stepsArr.length,
        section: typeof args.section === 'string' ? args.section : 'valchiria',
      };
      if (args.analysis !== undefined) insert.analysis = args.analysis;
      if (args.project_id !== undefined) insert.project_id = args.project_id;
      const { data, error } = await supabase
        .from('archived_funnels')
        .insert(insert)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return { swipe_funnel: data };
    }
    case 'valchiria_update_swipe_funnel': {
      const allowed = ['name', 'steps', 'total_steps', 'analysis', 'section', 'project_id'];
      const updates: Record<string, unknown> = {};
      for (const k of allowed) {
        if (args[k] !== undefined) updates[k] = args[k];
      }
      if (Array.isArray(args.steps) && args.total_steps === undefined) {
        updates.total_steps = (args.steps as unknown[]).length;
      }
      const { data, error } = await supabase
        .from('archived_funnels')
        .update(updates)
        .eq('id', args.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return { swipe_funnel: data };
    }
    case 'valchiria_add_step': {
      const { data: existing, error: fetchErr } = await supabase
        .from('archived_funnels')
        .select('steps')
        .eq('id', args.funnel_id)
        .single();
      if (fetchErr) throw new Error(fetchErr.message);
      const steps = Array.isArray((existing as { steps?: unknown[] })?.steps)
        ? [...((existing as { steps?: unknown[] }).steps as unknown[])]
        : [];
      const stepIndex = typeof args.step_index === 'number'
        ? args.step_index
        : steps.length;
      const newStep = {
        step_index: stepIndex,
        name: args.name,
        url_to_swipe: args.url_to_swipe,
        page_type: args.page_type || 'landing',
        prompt: args.prompt || '',
        product_name: args.product_name || '',
      };
      steps.push(newStep);
      const { data, error } = await supabase
        .from('archived_funnels')
        .update({ steps, total_steps: steps.length })
        .eq('id', args.funnel_id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return { swipe_funnel: data, added_step: newStep };
    }
    case 'valchiria_remove_step': {
      const { data: existing, error: fetchErr } = await supabase
        .from('archived_funnels')
        .select('steps')
        .eq('id', args.funnel_id)
        .single();
      if (fetchErr) throw new Error(fetchErr.message);
      const stepsArr = Array.isArray((existing as { steps?: unknown[] })?.steps)
        ? ((existing as { steps?: unknown[] }).steps as Array<{ step_index?: number }>)
        : [];
      const filtered = stepsArr.filter(s => s.step_index !== args.step_index);
      const { data, error } = await supabase
        .from('archived_funnels')
        .update({ steps: filtered, total_steps: filtered.length })
        .eq('id', args.funnel_id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return { swipe_funnel: data, removed: stepsArr.length - filtered.length };
    }
    case 'valchiria_delete_swipe_funnel': {
      const { error } = await supabase
        .from('archived_funnels')
        .delete()
        .eq('id', args.id);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    case 'valchiria_load_steps_to_funnel': {
      const targetProductId = String(args.target_product_id);
      const selections = (args.selections as Array<{ funnel_id: string; step_index: number }>) || [];
      const wipeExisting = args.wipe_existing !== false;

      if (!targetProductId) throw new Error('target_product_id is required');
      if (selections.length === 0) throw new Error('selections cannot be empty');

      // 1. Fetch all referenced swipe funnels
      const funnelIds = Array.from(new Set(selections.map(s => s.funnel_id)));
      const { data: funnels, error: fErr } = await supabase
        .from('archived_funnels')
        .select('id, name, steps')
        .in('id', funnelIds);
      if (fErr) throw new Error(fErr.message);

      // 2. Resolve each (funnel_id, step_index) → step detail
      const stepsToLoad: Array<{
        name: string;
        url_to_swipe: string;
        page_type: string;
        prompt: string;
        source_funnel: string;
      }> = [];
      for (const sel of selections) {
        const f = funnels?.find(x => x.id === sel.funnel_id);
        if (!f) continue;
        const fSteps = Array.isArray(f.steps)
          ? (f.steps as Array<{ step_index: number; name: string; url_to_swipe: string; page_type: string; prompt: string }>)
          : [];
        const step = fSteps.find(s => s.step_index === sel.step_index);
        if (!step) continue;
        stepsToLoad.push({
          name: step.name,
          url_to_swipe: step.url_to_swipe || '',
          page_type: step.page_type || 'landing',
          prompt: step.prompt || '',
          source_funnel: f.name,
        });
      }

      if (stepsToLoad.length === 0) {
        throw new Error('No matching steps found for the provided selections');
      }

      // 3. Wipe existing funnel_pages if requested
      let wiped = 0;
      if (wipeExisting) {
        const { count, error: delErr } = await supabase
          .from('funnel_pages')
          .delete({ count: 'exact' })
          .neq('id', '00000000-0000-0000-0000-000000000000');
        if (delErr) throw new Error(`Wipe failed: ${delErr.message}`);
        wiped = count || 0;
      }

      // 4. Insert new funnel_pages, one per selected step
      const inserts = stepsToLoad.map(s => ({
        name: s.name,
        page_type: s.page_type,
        product_id: targetProductId,
        url_to_swipe: s.url_to_swipe,
        prompt: s.prompt,
        swipe_status: 'pending',
      }));
      const { data: created, error: insErr } = await supabase
        .from('funnel_pages')
        .insert(inserts)
        .select();
      if (insErr) throw new Error(`Insert failed: ${insErr.message}`);

      return {
        success: true,
        loaded: created?.length || 0,
        wiped,
        target_product_id: targetProductId,
        funnel_pages: created,
      };
    }

    // ─── BROWSER AGENTICO ──────────────────────────────────────────────
    case 'browser_agentico_start':
      return await proxyApiCall('POST', '/api/browser-agentico/start', args, {}, 60_000);
    case 'browser_agentico_status':
      return await proxyApiCall('GET', `/api/browser-agentico/status/${args.jobId}`, {}, {}, 30_000);

    // ─── AGENTIC ───────────────────────────────────────────────────────
    case 'agentic_extract':
      return await proxyApiCall('POST', '/api/agentic/extract', args, {}, 180_000);
    case 'agentic_scrape':
      return await proxyApiCall('POST', '/api/agentic/scrape', args, {}, 180_000);
    case 'agentic_analyze':
      return await proxyApiCall('POST', '/api/agentic/analyze', args, {}, 180_000);
    case 'agentic_vision':
      return await proxyApiCall('POST', '/api/agentic/vision', args, {}, 180_000);
    case 'agentic_health':
      return await proxyApiCall('GET', '/api/agentic/health', {}, {}, 15_000);
    case 'agentic_swipe':
      return await proxyApiCall('POST', '/api/agentic-swipe', args, {}, 300_000);

    // ─── DEPLOY ────────────────────────────────────────────────────────
    case 'deploy_funnelish':
      return await proxyApiCall('POST', '/api/deploy/funnelish', args, {}, 180_000);
    case 'deploy_checkout_champ':
      return await proxyApiCall('POST', '/api/deploy/checkout-champ', args, {}, 180_000);
    case 'deploy_checkout_champ_tracking':
      return await proxyApiCall('POST', '/api/deploy/checkout-champ/tracking', args, {}, 60_000);

    // ─── VISION JOBS ───────────────────────────────────────────────────
    case 'list_vision_jobs':
      return await proxyApiCall('GET', '/api/vision/jobs', {}, {}, 30_000);
    case 'get_vision_job':
      return await proxyApiCall('GET', `/api/vision/jobs/${args.jobId}`, {}, {}, 30_000);

    // ─── CURSOR AGENTS ─────────────────────────────────────────────────
    case 'list_cursor_agents':
      return await proxyApiCall('GET', '/api/cursor-agents', {}, {}, 30_000);
    case 'create_cursor_agent':
      return await proxyApiCall('POST', '/api/cursor-agents', args, {}, 60_000);
    case 'cursor_agent_followup':
      return await proxyApiCall('POST', `/api/cursor-agents/${args.id}/followup`, { message: args.message }, {}, 60_000);

    // ─── AFFILIATE ─────────────────────────────────────────────────────
    case 'affiliate_save_funnel':
      return await proxyApiCall('POST', '/api/affiliate-browser-chat/save-funnel', args, {}, 60_000);

    // ─── GENERATE QUIZ ─────────────────────────────────────────────────
    case 'generate_quiz':
      return await proxyApiCall('POST', '/api/generate-quiz', args, {}, 240_000);

    // ─── GENERIC DB ────────────────────────────────────────────────────
    case 'db_list_tables':
      return { tables: DB_TABLES, count: DB_TABLES.length };

    case 'db_select': {
      const table = String(args.table);
      if (!DB_TABLES.includes(table)) throw new Error(`Unknown or non-allowed table: ${table}. Call db_list_tables first.`);
      const columns = String(args.columns || '*');
      const orderBy = String(args.orderBy || 'created_at');
      const ascending = Boolean(args.ascending);
      const limit = Math.min(Number(args.limit) || 100, 1000);
      const offset = Number(args.offset) || 0;

      let q = supabase.from(table).select(columns, { count: 'exact' });

      const filters = (args.filters as Record<string, unknown>) || {};
      for (const [col, raw] of Object.entries(filters)) {
        if (typeof raw === 'string' && raw.includes(':')) {
          const [op, ...rest] = raw.split(':');
          const val = rest.join(':');
          switch (op) {
            case 'ilike': q = q.ilike(col, val); break;
            case 'like': q = q.like(col, val); break;
            case 'gt': q = q.gt(col, val); break;
            case 'gte': q = q.gte(col, val); break;
            case 'lt': q = q.lt(col, val); break;
            case 'lte': q = q.lte(col, val); break;
            case 'neq': q = q.neq(col, val); break;
            case 'in': q = q.in(col, val.split(',')); break;
            case 'is': q = q.is(col, val === 'null' ? null : val); break;
            default: q = q.eq(col, raw);
          }
        } else {
          q = q.eq(col, raw);
        }
      }

      try { q = q.order(orderBy, { ascending }); } catch { /* table may not have created_at */ }
      q = q.range(offset, offset + limit - 1);

      const { data, error, count } = await q;
      if (error) throw new Error(error.message);
      return { table, rows: data, count: count || data?.length || 0, limit, offset };
    }

    case 'db_insert': {
      const table = String(args.table);
      if (!DB_TABLES.includes(table)) throw new Error(`Unknown or non-allowed table: ${table}`);
      const data = args.data;
      if (!data) throw new Error('data is required');
      const { data: result, error } = await supabase.from(table).insert(data as Record<string, unknown> | Record<string, unknown>[]).select();
      if (error) throw new Error(error.message);
      return { table, inserted: result, count: result?.length || 0 };
    }

    case 'db_update': {
      const table = String(args.table);
      if (!DB_TABLES.includes(table)) throw new Error(`Unknown or non-allowed table: ${table}`);
      const filters = (args.filters as Record<string, unknown>) || {};
      const data = (args.data as Record<string, unknown>) || {};
      if (Object.keys(filters).length === 0) throw new Error('filters cannot be empty (refuse to update without where clause)');
      let q = supabase.from(table).update(data);
      for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
      const { data: result, error } = await q.select();
      if (error) throw new Error(error.message);
      return { table, updated: result, count: result?.length || 0 };
    }

    case 'db_delete': {
      const table = String(args.table);
      if (!DB_TABLES.includes(table)) throw new Error(`Unknown or non-allowed table: ${table}`);
      const filters = (args.filters as Record<string, unknown>) || {};
      if (Object.keys(filters).length === 0) throw new Error('filters cannot be empty (refuse to delete without where clause)');
      let q = supabase.from(table).delete({ count: 'exact' });
      for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
      const { error, count } = await q;
      if (error) throw new Error(error.message);
      return { table, deleted: count || 0 };
    }

    // ─── CHECKPOINT (qualitative funnel audit) ────────────────────────
    case 'checkpoint_list_funnels': {
      const query: Record<string, unknown> = {};
      if (args.projectId) query.projectId = String(args.projectId);
      return await proxyApiCall('GET', '/api/checkpoint/funnels', {}, query, 30_000);
    }
    case 'checkpoint_get_funnel':
      return await proxyApiCall('GET', `/api/checkpoint/${String(args.id)}`, {}, {}, 30_000);
    case 'checkpoint_create_funnel':
      return await proxyApiCall('POST', '/api/checkpoint/funnels', args, {}, 30_000);
    case 'checkpoint_delete_funnel':
      return await proxyApiCall('DELETE', `/api/checkpoint/${String(args.id)}`, {}, {}, 30_000);
    case 'checkpoint_run_start': {
      // Built-in Claude pipeline if `auditor` is omitted or 'claude'
      // (BLOCKING, capped at 300s by the underlying route). Otherwise
      // (`auditor: 'openclaw:neo'|'openclaw:morfeo'`) the route
      // enqueues the work for that specific worker via target_agent
      // and returns immediately — the proxy timeout of 300s is then
      // wildly more than needed but harmless.
      const { id, ...body } = args as Record<string, unknown>;
      return await proxyApiCall(
        'POST',
        `/api/checkpoint/${String(id)}/run`,
        body,
        {},
        300_000,
      );
    }
    case 'checkpoint_run_status':
      return await proxyApiCall('GET', `/api/checkpoint/runs/${String(args.runId)}`, {}, {}, 30_000);
    case 'checkpoint_latest_run':
      return await proxyApiCall('GET', `/api/checkpoint/${String(args.id)}/latest-run`, {}, {}, 30_000);
    case 'checkpoint_recent_logs': {
      const query: Record<string, unknown> = {};
      if (args.limit !== undefined) query.limit = String(args.limit);
      return await proxyApiCall('GET', '/api/checkpoint/logs', {}, query, 30_000);
    }
    case 'checkpoint_fetch_pages': {
      const { id, ...body } = args as Record<string, unknown>;
      return await proxyApiCall(
        'POST',
        `/api/checkpoint/${String(id)}/fetch-pages`,
        body,
        {},
        300_000,
      );
    }
    case 'checkpoint_save_run': {
      const { id, ...body } = args as Record<string, unknown>;
      return await proxyApiCall(
        'POST',
        `/api/checkpoint/${String(id)}/runs`,
        body,
        {},
        60_000,
      );
    }

    // ─── DISCOVERY ─────────────────────────────────────────────────────
    case 'list_sections':
      return { sections: SECTIONS, count: SECTIONS.length };
    case 'list_api_endpoints':
      return { endpoints: API_ENDPOINTS, count: API_ENDPOINTS.length };

    // ─── GENERIC INVOKE ────────────────────────────────────────────────
    case 'invoke_api': {
      const path = String(args.path || '');
      if (!path.startsWith('/api/')) throw new Error('path must start with /api/');
      const method = String(args.method || 'POST').toUpperCase();
      const body = (args.body as Record<string, unknown>) || {};
      const query = (args.query as Record<string, unknown>) || {};
      const timeoutMs = Math.min(Number(args.timeoutMs) || 180_000, 600_000);
      return await proxyApiCall(method, path, body, query, timeoutMs);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── HELPERS: proxy + manifests ──────────────────────────────────────────
function getBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL
    || process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`
    || 'https://cloner-funnel-builder.vercel.app'
  );
}

async function proxyApiCall(
  method: string,
  path: string,
  body: Record<string, unknown>,
  query: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const baseUrl = getBaseUrl();
  let url = `${baseUrl}${path}`;
  const queryKeys = Object.keys(query);
  if (queryKeys.length > 0) {
    const qs = new URLSearchParams();
    for (const k of queryKeys) qs.set(k, String(query[k]));
    url += `?${qs.toString()}`;
  }

  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (method !== 'GET' && method !== 'HEAD' && Object.keys(body).length > 0) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let parsed: unknown = text;
  if (ct.includes('application/json')) {
    try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  }
  if (!res.ok) {
    return { error: `HTTP ${res.status}`, status: res.status, body: parsed };
  }
  return parsed;
}

const DB_TABLES = [
  'products',
  'funnel_pages',
  'swipe_templates',
  'archived_funnels',
  'projects',
  'post_purchase_pages',
  'funnel_crawl_steps',
  'affiliate_browser_chats',
  'affiliate_saved_funnels',
  'saved_prompts',
  'scheduled_browser_jobs',
  'api_keys',
  'openclaw_messages',
];

const SECTIONS = [
  { path: '/projects', name: 'Projects', description: 'Umbrella entities grouping products, funnels, templates, archive, briefs' },
  { path: '/products', name: 'Products', description: 'Product catalog with descriptions, benefits, pricing, CTAs' },
  { path: '/front-end-funnel', name: 'Front End Funnel', description: 'Build / clone / rewrite the front-end funnel pages (bridge, VSL, presell, squeeze, checkout, upsell, downsell)' },
  { path: '/my-funnels', name: 'My Funnels', description: 'List of all saved funnel pages' },
  { path: '/templates', name: 'Templates', description: 'Saved swipe templates from competitor pages' },
  { path: '/m', name: 'My Archive', description: 'Archived full funnels with cached thumbnails' },
  { path: '/clone-landing', name: 'Clone Landing', description: 'Standalone landing page cloner' },
  { path: '/landing-analyzer', name: 'Landing Analyzer', description: 'Analyze a single landing page' },
  { path: '/copy-analyzer', name: 'Copy Analyzer', description: 'AI analysis of marketing copy' },
  { path: '/quiz-creator', name: 'Quiz Creator', description: 'Build / clone quiz funnels from screenshots' },
  { path: '/swipe-quiz', name: 'Swipe Quiz', description: 'Swipe an entire quiz funnel for a product' },
  { path: '/funnel-analyzer', name: 'Funnel Analyzer', description: 'Deep crawl + vision analysis of multi-step funnels' },
  { path: '/reverse-funnel', name: 'Reverse Funnel', description: 'Reverse-engineer competitor funnels from ad to checkout' },
  { path: '/strategist', name: 'Strategist', description: 'AI strategist for offer / funnel design' },
  { path: '/compliance-ai', name: 'Compliance AI', description: 'Check copy/pages against ad-platform compliance rules' },
  { path: '/post-purchase', name: 'Post Purchase', description: 'Post-purchase flow builder (upsells, thank-you, retention)' },
  { path: '/protocollo-valchiria', name: 'Protocollo Valchiria', description: 'Curated flows (groups of pages) per product with global filtering' },
  { path: '/agentic-swipe', name: 'Agentic Swipe', description: 'Autonomous agent that swipes funnels end-to-end' },
  { path: '/browser-agentico', name: 'Browser Agentico', description: 'Agentic browser for navigating and extracting from competitor sites' },
  { path: '/affiliate-browser-chat', name: 'Affiliate Browser Chat', description: 'Chat-driven affiliate funnel discovery and saving' },
  { path: '/coding-agent', name: 'Coding Agent', description: 'AI coding assistant for editing the funnel HTML/CSS/JS' },
  { path: '/firecrawl', name: 'Firecrawl', description: 'Deep web scraping with Firecrawl' },
  { path: '/deploy-funnel', name: 'Deploy Funnel', description: 'Deploy a built funnel to a public URL' },
  { path: '/prompts', name: 'Prompts', description: 'Reusable AI prompt library' },
  { path: '/api-keys', name: 'API Keys', description: 'Manage API keys + view MCP info' },
];

const API_ENDPOINTS = [
  // Public v1 (require API key with scoped permissions)
  { path: '/api/v1/projects', methods: ['GET', 'POST', 'PUT', 'DELETE'], description: 'Projects CRUD (scoped: read_products / write_products)' },
  { path: '/api/v1/products', methods: ['GET', 'POST', 'PUT', 'DELETE'], description: 'Products CRUD' },
  { path: '/api/v1/funnels', methods: ['GET', 'POST', 'PUT', 'DELETE'], description: 'Funnel pages CRUD' },
  { path: '/api/v1/templates', methods: ['GET', 'POST', 'PUT', 'DELETE'], description: 'Swipe templates CRUD' },
  { path: '/api/v1/archive', methods: ['GET', 'POST', 'PUT', 'DELETE'], description: 'Archived funnels CRUD' },
  { path: '/api/v1/chat', methods: ['POST'], description: 'Chat / AI conversation endpoint' },
  { path: '/api/v1/proxy', methods: ['GET', 'POST'], description: 'Proxy a URL through the tool' },

  // Cloning + landing
  { path: '/api/clone-funnel', methods: ['POST'], description: 'Clone a landing/funnel page (identical or rewrite mode)' },
  { path: '/api/clone-funnel/text-mappings', methods: ['POST'], description: 'Get text mappings for a cloned page' },
  { path: '/api/landing/clone', methods: ['POST'], description: 'Standalone landing cloner' },
  { path: '/api/landing/swipe', methods: ['POST'], description: 'Clone + rewrite landing for a product' },

  // Quiz
  { path: '/api/quiz-creator/analyze', methods: ['POST'], description: 'Analyze a quiz from URL+screenshot' },
  { path: '/api/quiz-creator/generate', methods: ['POST'], description: 'Generate pixel-perfect quiz HTML' },
  { path: '/api/quiz-creator/swipe-analysis', methods: ['POST'], description: 'Pre-swipe analysis for quiz' },
  { path: '/api/quiz/analyze', methods: ['POST'], description: 'Analyze quiz logic + flow' },
  { path: '/api/quiz-rewrite', methods: ['POST'], description: 'Rewrite quiz texts (Anthropic batched)' },
  { path: '/api/quiz-rewrite/extract', methods: ['POST'], description: 'Extract quiz texts from HTML (fast)' },

  // Swipe quiz
  { path: '/api/swipe-quiz/generate', methods: ['POST'], description: 'Single-pass swipe of a quiz' },
  { path: '/api/swipe-quiz/multiagent-generate', methods: ['POST'], description: 'Multi-agent swipe pipeline (slower, higher quality)' },
  { path: '/api/swipe-quiz/screenshot', methods: ['POST'], description: 'Take quiz screenshot' },
  { path: '/api/swipe-quiz/debug-gemini', methods: ['POST'], description: 'Debug Gemini swipe call' },

  // Funnel analyzer
  { path: '/api/funnel-analyzer/crawl/start', methods: ['POST'], description: 'Start a deep funnel crawl (returns jobId)' },
  { path: '/api/funnel-analyzer/crawl/status/[jobId]', methods: ['GET'], description: 'Get crawl status / partial results' },
  { path: '/api/funnel-analyzer/crawl', methods: ['GET', 'POST'], description: 'Crawl management' },
  { path: '/api/funnel-analyzer/save-steps', methods: ['POST'], description: 'Save discovered crawl steps as funnel pages' },
  { path: '/api/funnel-analyzer/save-steps/check', methods: ['POST'], description: 'Pre-check before saving steps' },
  { path: '/api/funnel-analyzer/save-vision', methods: ['POST'], description: 'Save vision analysis results' },
  { path: '/api/funnel-analyzer/vision', methods: ['POST'], description: 'Run vision AI on funnel pages' },
  { path: '/api/funnel/analyze', methods: ['POST'], description: 'High-level single-funnel analysis' },

  // Checkpoint (qualitative funnel audit, multi-step)
  { path: '/api/checkpoint/funnels', methods: ['GET', 'POST'], description: 'List or create Checkpoint funnels' },
  { path: '/api/checkpoint/funnels/import', methods: ['POST'], description: 'Bulk import funnels (eg. from a project)' },
  { path: '/api/checkpoint/[id]', methods: ['GET', 'DELETE'], description: 'Get a Checkpoint funnel + recent runs, or delete it' },
  { path: '/api/checkpoint/[id]/run', methods: ['POST'], description: 'Trigger an audit (auditor: claude=blocking | openclaw:neo|openclaw:morfeo=enqueue)' },
  { path: '/api/checkpoint/[id]/runs', methods: ['POST'], description: 'Save an external audit result (used by OpenClaw via MCP)' },
  { path: '/api/checkpoint/[id]/latest-run', methods: ['GET'], description: 'Most recent run for a funnel (polling-friendly)' },
  { path: '/api/checkpoint/[id]/fetch-pages', methods: ['POST'], description: 'Fetch live HTML/text of all funnel pages for external audits' },
  { path: '/api/checkpoint/[id]/openclaw-prep', methods: ['POST'], description: 'OpenClaw worker prep: returns per-category prompts (system+user) ready to send to the local model' },
  { path: '/api/checkpoint/runs/[runId]', methods: ['GET'], description: 'Single run by id (live partial results during a run)' },
  { path: '/api/checkpoint/runs/[runId]/openclaw-category', methods: ['POST'], description: 'OpenClaw worker callback: stream a per-category result into a running audit' },
  { path: '/api/checkpoint/runs/[runId]/openclaw-finalize', methods: ['POST'], description: 'OpenClaw worker callback: close a streaming audit (recomputes overall score server-side)' },
  { path: '/api/checkpoint/logs', methods: ['GET'], description: 'Global Checkpoint log (newest 200)' },
  { path: '/api/checkpoint/diagnose-fetch', methods: ['POST'], description: 'Diagnose the SPA fallback chain on a single URL' },

  // Reverse funnel
  { path: '/api/reverse-funnel/analyze', methods: ['POST'], description: 'Reverse-engineer a competitor funnel' },
  { path: '/api/reverse-funnel/generate-visual', methods: ['POST'], description: 'Generate visual diagram of a reversed funnel' },

  // Branding + compliance + strategist
  { path: '/api/branding/generate', methods: ['POST'], description: 'Generate brand kit (logo, colors, fonts, tagline)' },
  { path: '/api/compliance-ai', methods: ['POST'], description: 'Compliance check against ad networks' },

  // Briefs
  { path: '/api/product-brief', methods: ['POST'], description: 'Generate AI product brief' },
  { path: '/api/funnel-brief/chat', methods: ['POST'], description: 'Funnel brief chat assistant' },
  { path: '/api/briefs-sync', methods: ['POST'], description: 'Sync briefs across products' },

  // AI editing
  { path: '/api/ai-edit-html', methods: ['POST'], description: 'AI edit a full HTML page from instruction' },
  { path: '/api/ai-edit-element', methods: ['POST'], description: 'AI edit a single element' },
  { path: '/api/rewrite-section', methods: ['POST'], description: 'Rewrite one section of a landing' },

  // Catalog import
  { path: '/api/catalog-import/parse', methods: ['POST'], description: 'Parse Excel/CSV/JSON catalog' },
  { path: '/api/catalog-import/enrich', methods: ['POST'], description: 'Enrich parsed products with AI' },
  { path: '/api/catalog-import/extract-product-image', methods: ['POST'], description: 'Extract product image from a URL' },
  { path: '/api/catalog-import/upload-image', methods: ['POST'], description: 'Upload product image' },

  // Generate / media
  { path: '/api/generate-image', methods: ['POST'], description: 'AI image generation' },
  { path: '/api/generate-quiz', methods: ['POST'], description: 'Generate a quiz from scratch' },
  { path: '/api/product-image-search', methods: ['POST'], description: 'Search product images on the web' },
  { path: '/api/upload-media', methods: ['POST'], description: 'Upload media file to storage' },
  { path: '/api/thumbnail', methods: ['GET'], description: 'Get thumbnail screenshot of a URL' },
  { path: '/api/proxy-page', methods: ['GET'], description: 'Proxy a remote page (for previews)' },

  // Pipeline
  { path: '/api/pipeline/start', methods: ['POST'], description: 'Start a multi-step pipeline job' },
  { path: '/api/pipeline/status/[jobId]', methods: ['GET'], description: 'Pipeline job status' },
  { path: '/api/pipeline/result/[jobId]', methods: ['GET'], description: 'Pipeline job result' },
  { path: '/api/pipeline/jobs', methods: ['GET'], description: 'List pipeline jobs' },

  // Scheduled / cron
  { path: '/api/scheduled-jobs', methods: ['GET', 'POST', 'DELETE'], description: 'Scheduled jobs CRUD' },
  { path: '/api/scheduled-jobs/cron', methods: ['GET'], description: 'Trigger due scheduled jobs' },

  // Firecrawl
  { path: '/api/firecrawl', methods: ['POST'], description: 'Firecrawl deep scrape' },

  // OpenClaw
  { path: '/api/openclaw/chat', methods: ['POST'], description: 'OpenClaw chat (queue-based)' },
  { path: '/api/openclaw/queue', methods: ['POST'], description: 'Insert message into OpenClaw queue' },
  { path: '/api/openclaw/action', methods: ['POST'], description: 'Execute OpenClaw action' },
  { path: '/api/openclaw/config', methods: ['GET', 'POST'], description: 'OpenClaw config' },

  // Browser agentico + agentic
  { path: '/api/browser-agentico/start', methods: ['POST'], description: 'Start agentic browser session' },
  { path: '/api/browser-agentico/status/[jobId]', methods: ['GET'], description: 'Browser agentico job status' },
  { path: '/api/agentic/extract', methods: ['POST'], description: 'Agentic structured extraction' },
  { path: '/api/agentic/scrape', methods: ['POST'], description: 'Agentic scrape (markdown + meta)' },
  { path: '/api/agentic/analyze', methods: ['POST'], description: 'Agentic analysis' },
  { path: '/api/agentic/vision', methods: ['POST'], description: 'Agentic vision analysis' },
  { path: '/api/agentic/health', methods: ['GET'], description: 'Agentic health' },
  { path: '/api/agentic-swipe', methods: ['POST'], description: 'Autonomous agentic swipe pipeline' },

  // Deploy
  { path: '/api/deploy/funnelish', methods: ['POST'], description: 'Deploy to Funnelish' },
  { path: '/api/deploy/checkout-champ', methods: ['POST'], description: 'Deploy to Checkout Champ' },
  { path: '/api/deploy/checkout-champ/tracking', methods: ['POST'], description: 'Checkout Champ tracking config' },

  // Vision jobs
  { path: '/api/vision/jobs', methods: ['GET', 'POST'], description: 'Vision jobs list / create' },
  { path: '/api/vision/jobs/[jobId]', methods: ['GET'], description: 'Vision job detail' },

  // Cursor agents
  { path: '/api/cursor-agents', methods: ['GET', 'POST'], description: 'Cursor coding-agent sessions' },
  { path: '/api/cursor-agents/[id]/followup', methods: ['POST'], description: 'Send follow-up to Cursor agent' },

  // Saved prompts
  { path: '/api/prompts', methods: ['GET', 'POST', 'PUT', 'DELETE'], description: 'Saved prompts library CRUD' },

  // Generate quiz
  { path: '/api/generate-quiz', methods: ['POST'], description: 'Generate a quiz funnel from scratch' },

  // Affiliate
  { path: '/api/affiliate-browser-chat/save-funnel', methods: ['POST'], description: 'Save discovered affiliate funnel' },

  // Misc
  { path: '/api/analyze-copy', methods: ['POST'], description: 'Analyze copy of a landing' },
  { path: '/api/api-keys', methods: ['GET', 'POST', 'DELETE'], description: 'Manage API keys' },
  { path: '/api/health', methods: ['GET'], description: 'Health check' },
  { path: '/api/supabase/test', methods: ['GET'], description: 'Supabase connectivity test' },
  { path: '/api/debug/anthropic-key', methods: ['GET'], description: 'Diagnose Anthropic API key' },
  { path: '/api/mcp', methods: ['POST', 'GET', 'DELETE', 'OPTIONS'], description: 'This MCP endpoint' },
];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpcResponse(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isNotification(req: JsonRpcRequest): boolean {
  // A JSON-RPC notification has no `id` field. MCP also treats `notifications/*` as notifications.
  return req.id === undefined || req.method?.startsWith('notifications/');
}

async function dispatch(msg: JsonRpcRequest): Promise<unknown | null> {
  const { jsonrpc, id, method, params } = msg;

  if (jsonrpc !== '2.0') {
    return jsonRpcError(id ?? null, -32600, 'Invalid Request: must be JSON-RPC 2.0');
  }

  // Notifications do not produce a response body (per JSON-RPC 2.0).
  if (isNotification(msg)) {
    // Still handle any side-effects, but return null so the HTTP layer sends 202.
    return null;
  }

  switch (method) {
    case 'initialize': {
      // Echo back the client's requested protocol version if we support it,
      // otherwise return our latest supported version.
      const requested = (params as { protocolVersion?: string })?.protocolVersion;
      const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
      return jsonRpcResponse(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions: 'Funnel Swiper MCP: call tools/list then tools/call with a tool name and arguments.',
      });
    }

    case 'tools/list':
      return jsonRpcResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = (params as { name?: string })?.name;
      const toolArgs = ((params as { arguments?: Record<string, unknown> })?.arguments) || {};
      if (!toolName) {
        return jsonRpcError(id, -32602, 'Missing tool name');
      }
      const toolDef = TOOLS.find(t => t.name === toolName);
      if (!toolDef) {
        return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      try {
        const result = await executeTool(toolName, toolArgs);
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        });
      }
    }

    case 'resources/list':
      return jsonRpcResponse(id, { resources: [] });

    case 'resources/templates/list':
      return jsonRpcResponse(id, { resourceTemplates: [] });

    case 'prompts/list':
      return jsonRpcResponse(id, { prompts: [] });

    case 'ping':
      return jsonRpcResponse(id, {});

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: baseHeaders() });
}

export async function POST(req: NextRequest) {
  const auth = await validateMcpAuth(req);
  if (!auth.valid) {
    return NextResponse.json(
      jsonRpcError(null, -32000, auth.error || 'Unauthorized'),
      { status: 401, headers: baseHeaders() }
    );
  }

  // Parse body (supports single JSON-RPC request or batch array).
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      jsonRpcError(null, -32700, 'Parse error'),
      { status: 400, headers: baseHeaders() }
    );
  }

  // Session management: on initialize, mint a session id. Echo it back on every response.
  let sessionId = req.headers.get('mcp-session-id') || undefined;
  const isInitialize = !Array.isArray(body) && body?.method === 'initialize';
  if (isInitialize && !sessionId) sessionId = randomUUID();

  const extraHeaders: Record<string, string> = {};
  if (sessionId) extraHeaders['Mcp-Session-Id'] = sessionId;

  // Handle batch requests
  if (Array.isArray(body)) {
    const results = await Promise.all(body.map(msg => dispatch(msg)));
    const responses = results.filter(r => r !== null);
    if (responses.length === 0) {
      // All messages were notifications → 202 Accepted, no body
      return new NextResponse(null, { status: 202, headers: baseHeaders(extraHeaders) });
    }
    return NextResponse.json(responses, {
      status: 200,
      headers: baseHeaders({ ...extraHeaders, 'Content-Type': 'application/json' }),
    });
  }

  // Single message
  const result = await dispatch(body);
  if (result === null) {
    // Notification → 202 Accepted, no body
    return new NextResponse(null, { status: 202, headers: baseHeaders(extraHeaders) });
  }
  return NextResponse.json(result, {
    status: 200,
    headers: baseHeaders({ ...extraHeaders, 'Content-Type': 'application/json' }),
  });
}

// GET on the MCP endpoint is optional in Streamable HTTP (would open a server-to-client SSE stream).
// We don't push server-initiated messages, so we return a capability descriptor instead.
// Clients that require a stream can still POST normally.
export async function GET(req: NextRequest) {
  const accept = req.headers.get('accept') || '';
  // If a client explicitly requests the stream, reply 405 per spec (we don't support server-initiated streams).
  if (accept.includes('text/event-stream')) {
    return new NextResponse('Server-initiated streams are not supported. POST to this endpoint instead.', {
      status: 405,
      headers: baseHeaders({ 'Content-Type': 'text/plain', 'Allow': 'POST, OPTIONS, DELETE' }),
    });
  }

  return NextResponse.json(
    {
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      protocol: 'MCP',
      protocolVersion: MCP_PROTOCOL_VERSION,
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      transport: 'streamable-http',
      contentType: 'application/json',
      tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
      auth: 'API key via X-API-Key header (requires full_access permission)',
      endpoint: '/api/mcp',
    },
    { headers: baseHeaders() }
  );
}

// DELETE is used in Streamable HTTP to terminate a session.
export async function DELETE(req: NextRequest) {
  const auth = await validateMcpAuth(req);
  if (!auth.valid) {
    return NextResponse.json(
      jsonRpcError(null, -32000, auth.error || 'Unauthorized'),
      { status: 401, headers: baseHeaders() }
    );
  }
  // Stateless: nothing to persist server-side, just acknowledge.
  return new NextResponse(null, { status: 204, headers: baseHeaders() });
}
