import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { createHash, randomUUID } from 'crypto';

const SERVER_INFO = {
  name: 'funnel-swiper-mcp',
  version: '1.1.0',
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
    description: 'Create a new funnel page',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Page name' },
        url: { type: 'string', description: 'Page URL' },
        page_type: { type: 'string', description: 'Type: bridge, vsl, presell, squeeze, checkout, upsell, downsell, thank_you' },
        product_id: { type: 'string', description: 'Associated product ID' },
        html_content: { type: 'string', description: 'HTML content of the page' },
        notes: { type: 'string', description: 'Notes about the page' },
      },
      required: ['name'],
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
        url: { type: 'string' },
        page_type: { type: 'string' },
        html_content: { type: 'string' },
        notes: { type: 'string' },
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
    description: 'List all saved swipe templates',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_template',
    description: 'Save a new swipe template',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Template name' },
        html: { type: 'string', description: 'Template HTML content' },
        source_url: { type: 'string', description: 'Source URL of the template' },
        page_type: { type: 'string', description: 'Page type' },
        tags: { type: 'string', description: 'Tags (comma separated)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_archive',
    description: 'List all archived funnels',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_archive_entry',
    description: 'Save a funnel to the archive',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Archive entry name' },
        url: { type: 'string', description: 'Funnel URL' },
        html_content: { type: 'string', description: 'HTML content' },
        page_type: { type: 'string', description: 'Page type' },
        notes: { type: 'string', description: 'Notes' },
      },
      required: ['name'],
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
        tone: { type: 'string', description: 'Copy tone (default: professional)' },
        language: { type: 'string', description: 'Language code (default: it)' },
      },
      required: ['source_url', 'product_id'],
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
    case 'create_template': {
      const { data, error } = await supabase.from('swipe_templates').insert(args).select().single();
      if (error) throw new Error(error.message);
      return { template: data };
    }
    case 'list_archive': {
      const { data, error } = await supabase.from('archived_funnels').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return { archived_funnels: data, count: data?.length || 0 };
    }
    case 'create_archive_entry': {
      const { data, error } = await supabase.from('archived_funnels').insert(args).select().single();
      if (error) throw new Error(error.message);
      return { archived_funnel: data };
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
      const res = await fetch(`${baseUrl}/api/landing/swipe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: args.source_url,
          product,
          tone: args.tone || 'professional',
          language: args.language || 'it',
        }),
        signal: AbortSignal.timeout(180000),
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
        provider: result.provider,
        changes: result.changes_made,
        html: result.html,
      };
    }
    case 'swipe_landing_for_product_id': {
      const { data: prod, error: prodErr } = await supabase.from('products').select('*').eq('id', args.product_id).single();
      if (prodErr || !prod) throw new Error(`Product not found: ${args.product_id}`);
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://cloner-funnel-builder.vercel.app';
      const res = await fetch(`${baseUrl}/api/landing/swipe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: args.source_url,
          product: {
            name: prod.name,
            description: prod.description,
            benefits: prod.benefits ? String(prod.benefits).split(',').map((b: string) => b.trim()) : [],
            price: prod.price,
            cta_text: prod.cta_text,
            cta_url: prod.cta_url,
            target_audience: prod.target_audience,
            brand_name: prod.brand_name,
          },
          tone: args.tone || 'professional',
          language: args.language || 'it',
        }),
        signal: AbortSignal.timeout(180000),
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
        provider: result.provider,
        changes: result.changes_made,
        html: result.html,
      };
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

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
