import { NextRequest, NextResponse } from 'next/server';

const getConfig = () => ({
  baseUrl: process.env.OPENCLAW_BASE_URL || 'http://69.197.168.23:19001',
  apiKey: process.env.OPENCLAW_API_KEY || '',
  model: process.env.OPENCLAW_MODEL || 'openclaw:neo',
});

interface ToolAction {
  action: string;
  params: Record<string, unknown>;
}

const ACTION_DETECTION_PROMPT = `You are an AI that detects when a user wants to perform an action in a marketing funnel tool.
Analyze the user message and determine if they want to execute a tool action.

AVAILABLE ACTIONS BY SECTION:

== COPY ANALYZER ==
- analyze_copy: Analyze marketing copy from a URL. Params: { url: string }

== LANDING ANALYZER ==
- analyze_landing: Analyze a landing page in depth. Params: { url: string }

== FUNNEL ANALYZER ==
- analyze_funnel: Analyze an entire sales funnel. Params: { url: string }
- reverse_funnel: Reverse-engineer a competitor funnel. Params: { url: string }

== AFFILIATE BROWSER CHAT ==
- start_browser_agent: Start browser agent to navigate and research. Params: { prompt: string, startUrl?: string }

== FRONT END FUNNEL ==
- add_funnel_page: Add a new step/page to the front-end funnel. Params: { name: string, pageType: string, url?: string, productId?: string }
- swipe_page: Swipe/adapt a page for a different product. Params: { url: string, productName: string }

== POST PURCHASE ==
- add_post_purchase: Add a post-purchase page (upsell/downsell/thankyou). Params: { name: string, type: string, url?: string }

== MY PRODUCTS ==
- create_product: Create a new product. Params: { name: string, description?: string, price?: number }
- list_products: List all products. Params: {}
- generate_brief: Generate AI product brief. Params: { productName: string }

== MY ARCHIVE / TEMPLATES ==
- list_templates: List saved templates. Params: {}
- list_archive: List archived/saved funnels. Params: {}

== CLONE & SWIPE ==
- clone_page: Clone/download landing page HTML. Params: { url: string }
- swipe_clone: Clone a page and swipe it for a product. Params: { url: string, productName: string }

== QUIZ CREATOR ==
- generate_quiz: Generate a quiz funnel. Params: { topic: string, productName?: string }

== COMPLIANCE AI ==
- check_compliance: Check a page for FTC/advertising compliance. Params: { url: string }

== DEPLOY ==
- deploy_funnel: Deploy funnel to a platform. Params: { platform: string }

== AI EDITING ==
- rewrite_section: Rewrite marketing copy. Params: { text: string, instructions: string }
- edit_html: AI-edit HTML content. Params: { html: string, instructions: string }
- generate_image: Generate an image with AI. Params: { prompt: string }

== MY PROMPTS ==
- list_prompts: List saved prompts. Params: {}
- save_prompt: Save a new prompt. Params: { name: string, content: string }

== PROTOCOLLO VALCHIRIA ==
- list_flows: List all funnel flows. Params: {}

== DATA ==
- list_funnels: List saved funnels from My Funnels. Params: {}

== GENERAL ==
- no_action: Just a regular chat/question, no tool action needed. Params: {}

RULES:
- If the user asks a question or wants advice, use no_action
- If the user clearly wants to DO something (create, analyze, clone, deploy, list, generate...), detect the right action
- Extract URLs, names, and parameters from the message
- Respond ONLY with valid JSON: { "action": "action_name", "params": { ... } }`;

async function detectAction(userMessage: string, section: string, config: ReturnType<typeof getConfig>): Promise<ToolAction> {
  try {
    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: ACTION_DETECTION_PROMPT + `\n\nThe user is currently in the "${section}" section.` },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return { action: 'no_action', params: {} };

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { action: 'no_action', params: {} };

    return JSON.parse(jsonMatch[0]);
  } catch {
    return { action: 'no_action', params: {} };
  }
}

async function executeAction(action: ToolAction, origin: string): Promise<{ success: boolean; result: string; data?: unknown }> {
  const { action: a, params: p } = action;

  try {
    switch (a) {

      // ── ANALYZERS ──
      case 'analyze_copy': {
        const url = p.url as string;
        if (!url) return fail('URL is required.');
        const res = await fetch(`${origin}/api/analyze-copy`, { method: 'POST', headers: json(), body: JSON.stringify({ url }) });
        const d = await res.json();
        return { success: res.ok, result: d.analysis || d.error || 'Analysis complete.', data: d };
      }
      case 'analyze_landing': {
        const url = p.url as string;
        if (!url) return fail('URL is required.');
        const res = await fetch(`${origin}/api/funnel-brief/analyze`, { method: 'POST', headers: json(), body: JSON.stringify({ url }) });
        const d = await res.json();
        return { success: res.ok, result: d.analysis || d.brief || d.error || 'Analysis complete.', data: d };
      }
      case 'analyze_funnel': {
        const url = p.url as string;
        if (!url) return fail('URL is required.');
        const res = await fetch(`${origin}/api/funnel/analyze`, { method: 'POST', headers: json(), body: JSON.stringify({ url }) });
        const d = await res.json();
        return { success: res.ok, result: d.analysis || d.error || 'Funnel analysis complete.', data: d };
      }
      case 'reverse_funnel': {
        const url = p.url as string;
        if (!url) return fail('URL is required.');
        const res = await fetch(`${origin}/api/reverse-funnel/analyze`, { method: 'POST', headers: json(), body: JSON.stringify({ url }) });
        const d = await res.json();
        return { success: res.ok, result: d.analysis || d.error || 'Reverse funnel complete.', data: d };
      }

      // ── BROWSER AGENT ──
      case 'start_browser_agent': {
        const prompt = p.prompt as string;
        if (!prompt) return fail('Prompt is required.');
        const res = await fetch(`${origin}/api/affiliate-browser-chat/start`, { method: 'POST', headers: json(), body: JSON.stringify({ prompt, startUrl: p.startUrl || undefined, maxTurns: 50 }) });
        const d = await res.json();
        if (d.success) return { success: true, result: `Browser agent started! Job ID: ${d.jobId}. Check Affiliate Browser Chat for live progress.`, data: d };
        return { success: false, result: d.error || 'Failed to start.' };
      }

      // ── CLONE & SWIPE ──
      case 'clone_page': {
        const url = p.url as string;
        if (!url) return fail('URL is required.');
        const res = await fetch(`${origin}/api/landing/clone`, { method: 'POST', headers: json(), body: JSON.stringify({ url }) });
        const d = await res.json();
        if (res.ok && d.html) return { success: true, result: `Page cloned! ${d.html.length} chars. Title: "${d.title || 'N/A'}"`, data: { title: d.title, length: d.html.length } };
        return { success: false, result: d.error || 'Clone failed.' };
      }
      case 'swipe_clone':
      case 'swipe_page': {
        const url = p.url as string;
        const productName = (p.productName || p.product) as string;
        if (!url) return fail('URL is required.');
        if (!productName) return fail('Product name is required.');
        const res = await fetch(`${origin}/api/landing/swipe`, { method: 'POST', headers: json(), body: JSON.stringify({ url, product: { name: productName } }) });
        const d = await res.json();
        if (res.ok && d.html) return { success: true, result: `Page swiped for "${productName}"! ${d.html.length} chars.`, data: { length: d.html.length } };
        return { success: false, result: d.error || 'Swipe failed.' };
      }

      // ── PRODUCTS ──
      case 'create_product': {
        const name = p.name as string;
        if (!name) return fail('Product name is required.');
        const res = await fetch(`${origin}/api/v1/products`, { method: 'POST', headers: json(), body: JSON.stringify({ name, description: p.description || '', price: p.price || 0, benefits: [], cta_text: 'Buy Now', cta_url: '', brand_name: '' }) });
        const d = await res.json();
        return res.ok ? { success: true, result: `Product "${name}" created!`, data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'list_products': {
        const res = await fetch(`${origin}/api/v1/products`);
        const d = await res.json();
        const products = d.products || d.data || [];
        if (products.length === 0) return { success: true, result: 'No products found.' };
        const list = products.map((pr: { name: string; price: number }, i: number) => `${i + 1}. ${pr.name} (€${pr.price})`).join('\n');
        return { success: true, result: `${products.length} products:\n${list}`, data: products };
      }
      case 'generate_brief': {
        const name = p.productName as string;
        if (!name) return fail('Product name is required.');
        const res = await fetch(`${origin}/api/product-brief`, { method: 'POST', headers: json(), body: JSON.stringify({ product: { name } }) });
        const d = await res.json();
        return { success: res.ok, result: d.brief || d.error || 'Brief generated.', data: d };
      }

      // ── FUNNEL PAGES ──
      case 'add_funnel_page': {
        const name = p.name as string;
        if (!name) return fail('Page name is required.');
        const res = await fetch(`${origin}/api/v1/funnels`, { method: 'POST', headers: json(), body: JSON.stringify({ name, page_type: p.pageType || 'bridge', url_to_swipe: p.url || '', product_id: p.productId || null, swipe_status: 'pending' }) });
        const d = await res.json();
        return res.ok ? { success: true, result: `Funnel page "${name}" added!`, data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'add_post_purchase': {
        const name = p.name as string;
        if (!name) return fail('Page name is required.');
        return { success: true, result: `Post-purchase page "${name}" noted. Go to Post Purchase section to finalize.` };
      }
      case 'list_funnels': {
        const res = await fetch(`${origin}/api/v1/funnels`);
        const d = await res.json();
        const pages = d.funnel_pages || d.data || [];
        if (pages.length === 0) return { success: true, result: 'No funnel pages found.' };
        const list = pages.map((pg: { name: string; page_type: string }, i: number) => `${i + 1}. ${pg.name} (${pg.page_type})`).join('\n');
        return { success: true, result: `${pages.length} funnel pages:\n${list}`, data: pages };
      }
      case 'list_flows': {
        const res = await fetch(`${origin}/api/v1/funnels`);
        const d = await res.json();
        const pages = d.funnel_pages || d.data || [];
        if (pages.length === 0) return { success: true, result: 'No flows found.' };
        const list = pages.map((pg: { name: string; page_type: string }, i: number) => `${i + 1}. ${pg.name} (${pg.page_type})`).join('\n');
        return { success: true, result: `${pages.length} flows:\n${list}`, data: pages };
      }

      // ── ARCHIVE & TEMPLATES ──
      case 'list_templates': {
        const res = await fetch(`${origin}/api/v1/templates`);
        const d = await res.json();
        const templates = d.templates || d.data || [];
        if (templates.length === 0) return { success: true, result: 'No templates found.' };
        const list = templates.map((t: { name: string; page_type: string }, i: number) => `${i + 1}. ${t.name} (${t.page_type})`).join('\n');
        return { success: true, result: `${templates.length} templates:\n${list}`, data: templates };
      }
      case 'list_archive': {
        const res = await fetch(`${origin}/api/v1/archive`);
        const d = await res.json();
        const funnels = d.archived_funnels || d.data || [];
        if (funnels.length === 0) return { success: true, result: 'No archived funnels.' };
        const list = funnels.map((f: { name: string; total_steps: number }, i: number) => `${i + 1}. ${f.name} (${f.total_steps} steps)`).join('\n');
        return { success: true, result: `${funnels.length} archived funnels:\n${list}`, data: funnels };
      }

      // ── QUIZ ──
      case 'generate_quiz': {
        const topic = p.topic as string;
        if (!topic) return fail('Quiz topic is required.');
        const res = await fetch(`${origin}/api/generate-quiz`, { method: 'POST', headers: json(), body: JSON.stringify({ topic, productName: p.productName || topic }) });
        const d = await res.json();
        return { success: res.ok, result: d.quiz || d.html ? 'Quiz generated!' : (d.error || 'Quiz generation failed.'), data: d };
      }

      // ── COMPLIANCE ──
      case 'check_compliance': {
        const url = p.url as string;
        if (!url) return fail('URL is required.');
        const res = await fetch(`${origin}/api/compliance-ai/check`, { method: 'POST', headers: json(), body: JSON.stringify({ url }) });
        const d = await res.json();
        return { success: res.ok, result: d.analysis || d.report || d.error || 'Compliance check done.', data: d };
      }

      // ── DEPLOY ──
      case 'deploy_funnel': {
        const platform = (p.platform as string || '').toLowerCase();
        if (!platform) return fail('Platform name is required (funnelish or checkout-champ).');
        return { success: true, result: `To deploy, go to the Deploy Funnel section and select "${platform}". The deployment requires configuration specific to your account.` };
      }

      // ── AI EDITING ──
      case 'rewrite_section': {
        const text = p.text as string;
        if (!text) return fail('Text to rewrite is required.');
        const res = await fetch(`${origin}/api/rewrite-section`, { method: 'POST', headers: json(), body: JSON.stringify({ text, instructions: p.instructions || 'Improve this copy for higher conversion' }) });
        const d = await res.json();
        return { success: res.ok, result: d.rewritten || d.result || d.error || 'Rewrite complete.', data: d };
      }
      case 'edit_html': {
        const html = p.html as string;
        if (!html) return fail('HTML content is required.');
        const res = await fetch(`${origin}/api/ai-edit-html`, { method: 'POST', headers: json(), body: JSON.stringify({ html, prompt: p.instructions || 'Improve this page' }) });
        const d = await res.json();
        return { success: res.ok, result: d.html ? 'HTML edited successfully!' : (d.error || 'Edit failed.'), data: d };
      }
      case 'generate_image': {
        const prompt = p.prompt as string;
        if (!prompt) return fail('Image description is required.');
        const res = await fetch(`${origin}/api/generate-image`, { method: 'POST', headers: json(), body: JSON.stringify({ prompt }) });
        const d = await res.json();
        return { success: res.ok, result: d.url ? `Image generated: ${d.url}` : (d.error || 'Image generation failed.'), data: d };
      }

      // ── PROMPTS ──
      case 'list_prompts': {
        const res = await fetch(`${origin}/api/prompts`);
        const d = await res.json();
        const prompts = d.prompts || d.data || [];
        if (prompts.length === 0) return { success: true, result: 'No saved prompts.' };
        const list = prompts.map((pr: { name: string }, i: number) => `${i + 1}. ${pr.name}`).join('\n');
        return { success: true, result: `${prompts.length} saved prompts:\n${list}`, data: prompts };
      }
      case 'save_prompt': {
        const name = p.name as string;
        const content = p.content as string;
        if (!name || !content) return fail('Name and content are required.');
        const res = await fetch(`${origin}/api/prompts`, { method: 'POST', headers: json(), body: JSON.stringify({ name, content }) });
        const d = await res.json();
        return res.ok ? { success: true, result: `Prompt "${name}" saved!`, data: d } : { success: false, result: d.error || 'Failed.' };
      }

      default:
        return { success: false, result: 'Unknown action.' };
    }
  } catch (err) {
    return { success: false, result: `Action failed: ${(err as Error).message}` };
  }
}

function fail(msg: string) { return { success: false, result: msg }; }
function json() { return { 'Content-Type': 'application/json' }; }

export async function POST(req: NextRequest) {
  const { message, section, conversationHistory } = await req.json();

  if (!message) {
    return NextResponse.json({ error: 'Missing message' }, { status: 400 });
  }

  const config = getConfig();
  if (!config.apiKey) {
    return NextResponse.json({ error: 'OpenClaw API key not configured' }, { status: 500 });
  }

  const origin = req.nextUrl.origin;

  // Step 1: Detect action
  const detectedAction = await detectAction(message, section, config);

  // Step 2: Execute if action detected
  let actionResult: { success: boolean; result: string; data?: unknown } | null = null;
  if (detectedAction.action !== 'no_action') {
    actionResult = await executeAction(detectedAction, origin);
  }

  // Step 3: Generate natural response with OpenClaw
  const systemPrompt = `You are OpenClaw, an AI assistant integrated into every section of the "Funnel Swiper" tool.
The user is in the "${section}" section.

${actionResult ? `
ACTION EXECUTED: ${detectedAction.action}
PARAMETERS: ${JSON.stringify(detectedAction.params)}
RESULT: ${actionResult.success ? 'SUCCESS' : 'FAILED'}
OUTPUT:
${actionResult.result}

Explain clearly what was done (or what failed and why). If data was returned, summarize it nicely.
` : 'The user is asking a question or chatting. Respond helpfully based on your knowledge.'}

Be concise, helpful, actionable. Respond in the same language the user writes in (Italian or English).`;

  const history = (conversationHistory || []).slice(-10);
  history.push({ role: 'user', content: message });

  try {
    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'system', content: systemPrompt }, ...history],
        temperature: 0.7,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ error: `OpenClaw error: ${res.status} - ${errText}` }, { status: res.status });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';

    return NextResponse.json({
      content,
      actionExecuted: detectedAction.action !== 'no_action' ? detectedAction.action : null,
      actionSuccess: actionResult?.success ?? null,
      actionData: actionResult?.data ?? null,
    });
  } catch (err) {
    return NextResponse.json({ error: `OpenClaw connection failed: ${(err as Error).message}` }, { status: 502 });
  }
}
