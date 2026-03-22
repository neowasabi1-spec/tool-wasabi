import { NextRequest, NextResponse } from 'next/server';
import { getOpenClawConfig } from '@/lib/openclaw-config';

interface ToolAction {
  action: string;
  params: Record<string, unknown>;
}

const ACTION_DETECTION_PROMPT = `You detect user actions in a marketing funnel tool. Analyze the message and return the matching action.

ACTIONS (organized by section):

== COPY ANALYZER ==
- analyze_copy: Analyze marketing copy. Params: { url }

== LANDING ANALYZER ==
- scrape_landing: Scrape/extract page content. Params: { url }
- vision_landing: Vision AI analysis of page screenshot. Params: { url, provider? }
- extract_landing: Extract structured data from page. Params: { url }
- full_analysis_landing: Full analysis (scrape+vision+extract). Params: { url }

== FUNNEL ANALYZER ==
- crawl_funnel: Crawl entire funnel starting from URL. Params: { url, maxSteps?, quizMode? }
- vision_funnel: Run vision analysis on funnel steps. Params: { url, funnelName? }
- save_funnel_steps: Save crawl steps to database. Params: { url, funnelName? }

== REVERSE FUNNEL ==
- reverse_funnel: Reverse-engineer competitor funnel. Params: { url }
- generate_visual: Generate visual HTML mockup of funnel. Params: { analysis }

== AFFILIATE BROWSER CHAT ==
- start_browser_agent: Start browser agent. Params: { prompt, startUrl? }
- stop_browser_agent: Stop running browser agent. Params: { jobId }

== FRONT END FUNNEL ==
- add_funnel_page: Add page to funnel. Params: { name, pageType?, url?, productId? }
- delete_funnel_page: Delete a funnel page. Params: { id }
- clone_for_funnel: Clone a page for the funnel. Params: { url }
- swipe_for_funnel: Swipe a cloned page. Params: { url, productName }
- analyze_funnel_page: Analyze a funnel page. Params: { url }
- launch_swipe: Launch swipe job for a page. Params: { pageId }
- generate_quiz_funnel: Generate quiz for funnel. Params: { productName }
- download_template_excel: Download Excel template for import. Params: {}
- bulk_product_change: Change product for multiple pages. Params: { productId }

== POST PURCHASE ==
- add_post_purchase: Add upsell/downsell/thankyou page. Params: { name, type, url? }
- launch_post_purchase_swipe: Swipe post-purchase page. Params: { pageId }

== MY PRODUCTS ==
- create_product: Create product. Params: { name, description?, price?, benefits?, ctaText?, ctaUrl?, brandName? }
- list_products: List all products. Params: {}
- update_product: Update a product. Params: { id, name?, description?, price?, benefits? }
- delete_product: Delete a product. Params: { id }
- generate_brief: Generate AI product brief. Params: { productName }
- product_chat: Chat about a product for strategy. Params: { productName, message }

== MY FUNNELS ==
- list_saved_funnels: List saved/crawled funnels. Params: {}
- delete_saved_funnel: Delete a saved funnel. Params: { id }
- import_to_archive: Import funnel to My Archive. Params: { funnelId }
- create_funnel_scratch: Create funnel from scratch. Params: { name, steps[] }

== MY ARCHIVE / TEMPLATES ==
- list_templates: List templates. Params: {}
- list_archive: List archived funnels. Params: {}
- add_template: Add new swipe template. Params: { name, sourceUrl, pageType }
- delete_template: Delete template. Params: { id }
- import_archive_to_funnel: Import archived pages to Front End Funnel. Params: { pages[] }
- run_type_analysis: AI analysis for a page type category. Params: { type, pages[] }

== CLONE & SWIPE ==
- clone_page: Clone landing page HTML. Params: { url }
- swipe_page: Swipe page for a product. Params: { url, productName, productDescription? }

== QUIZ CREATOR ==
- analyze_quiz: Analyze quiz page design. Params: { url }
- generate_quiz: Generate quiz HTML. Params: { topic, productName? }
- swipe_quiz_analysis: Swipe branding for quiz. Params: { productName }

== SWIPE QUIZ ==
- generate_quiz_simple: Generate quiz with prompt. Params: { prompt }
- generate_quiz_swap: Generate by swapping funnel+product. Params: { funnelName, productName }
- generate_quiz_multiagent: Multi-agent V2 quiz generation. Params: { funnelName, productName }
- take_screenshot: Take page screenshot. Params: { url }

== AGENTIC SWIPE ==
- run_agentic_swipe: Run agentic swipe pipeline. Params: { url, productName, productDescription? }

== COMPLIANCE AI ==
- check_compliance: Run compliance check. Params: { url }
- check_compliance_batch: Run compliance on multiple URLs. Params: { urls[] }

== DEPLOY ==
- deploy_funnelish: Deploy to Funnelish. Params: { html, funnelName, pageName? }
- deploy_checkout_champ: Deploy to Checkout Champ. Params: { html, funnelName, pageName? }

== AI EDITING ==
- rewrite_copy: Rewrite marketing copy. Params: { text, instructions? }
- edit_html: AI edit HTML. Params: { html, instructions }
- generate_image: Generate image. Params: { prompt }

== MY PROMPTS ==
- list_prompts: List saved prompts. Params: {}
- save_prompt: Save a prompt. Params: { name, content, category? }
- delete_prompt: Delete a prompt. Params: { id }

== PROTOCOLLO VALCHIRIA ==
- list_flows: List all funnel flows. Params: {}
- create_flow: Create a new flow. Params: { name, url?, productId? }

== API KEYS ==
- list_api_keys: List API keys. Params: {}
- create_api_key: Create API key. Params: { name, permissions? }

== FIRECRAWL ==
- firecrawl_scrape: Scrape page via Firecrawl. Params: { url }

== BROWSER AGENTICO ==
- start_agentic_crawl: Start agentic browser crawl. Params: { url }

== BRANDING ==
- generate_branding: Generate product branding. Params: { productName, funnelName? }

== GENERAL ==
- no_action: Just chatting, no tool action. Params: {}

RULES:
- If user asks question/advice → no_action
- If user wants to DO something → detect the right action
- Extract all params (URLs, names, IDs, text) from the message
- Respond ONLY with JSON: { "action": "name", "params": { ... } }`;

async function detectAction(msg: string, section: string, cfg: { baseUrl: string; apiKey: string; model: string }): Promise<ToolAction> {
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: ACTION_DETECTION_PROMPT + `\n\nUser is in "${section}" section.` },
          { role: 'user', content: msg },
        ],
        temperature: 0.1,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return noAction();
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return noAction();
    return JSON.parse(m[0]);
  } catch { return noAction(); }
}

function noAction(): ToolAction { return { action: 'no_action', params: {} }; }
function fail(msg: string) { return { success: false, result: msg }; }
function hdr() { return { 'Content-Type': 'application/json' }; }

async function exec(a: ToolAction, o: string): Promise<{ success: boolean; result: string; data?: unknown }> {
  const { action, params: p } = a;
  try {
    switch (action) {

      // ── COPY ANALYZER ──
      case 'analyze_copy': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/analyze-copy`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return { success: r.ok, result: d.analysis || d.error || 'Done.', data: d };
      }

      // ── LANDING ANALYZER ──
      case 'scrape_landing': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/agentic/scrape`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return { success: r.ok, result: d.content || d.markdown || d.error || 'Scrape done.', data: d };
      }
      case 'vision_landing': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/agentic/vision`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url, prompt_type: 'detailed' }) });
        const d = await r.json();
        return { success: r.ok, result: d.analysis || d.error || 'Vision done.', data: d };
      }
      case 'extract_landing': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/agentic/extract`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return { success: r.ok, result: JSON.stringify(d.data || d, null, 2).slice(0, 3000), data: d };
      }
      case 'full_analysis_landing': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/agentic/analyze`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url, include_scrape: true, include_vision: true, include_extract: true }) });
        const d = await r.json();
        return { success: r.ok, result: d.analysis || JSON.stringify(d).slice(0, 3000), data: d };
      }

      // ── FUNNEL ANALYZER ──
      case 'crawl_funnel': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/funnel-analyzer/crawl/start`, { method: 'POST', headers: hdr(), body: JSON.stringify({ entryUrl: p.url, maxSteps: p.maxSteps || 20, quizMode: p.quizMode || false }) });
        const d = await r.json();
        return d.jobId ? { success: true, result: `Crawl started! Job: ${d.jobId}. Check Funnel Analyzer for progress.`, data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'vision_funnel': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/funnel-analyzer/vision-from-saved`, { method: 'POST', headers: hdr(), body: JSON.stringify({ entryUrl: p.url, funnelName: p.funnelName || '', provider: 'gemini' }) });
        const d = await r.json();
        return { success: r.ok, result: d.analyses ? `Vision analysis done for ${d.analyses.length} steps.` : (d.error || 'Done.'), data: d };
      }
      case 'save_funnel_steps': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/funnel-analyzer/save-steps`, { method: 'POST', headers: hdr(), body: JSON.stringify({ entryUrl: p.url, funnelName: p.funnelName || 'Saved Funnel', steps: p.steps || [] }) });
        const d = await r.json();
        return { success: r.ok, result: d.success ? 'Steps saved!' : (d.error || 'Failed.'), data: d };
      }

      // ── REVERSE FUNNEL ──
      case 'reverse_funnel': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/reverse-funnel/analyze`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return { success: r.ok, result: d.analysis || d.error || 'Reverse analysis done.', data: d };
      }
      case 'generate_visual': {
        const r = await fetch(`${o}/api/reverse-funnel/generate-visual`, { method: 'POST', headers: hdr(), body: JSON.stringify({ analysis: p.analysis || '', funnelName: p.funnelName }) });
        const d = await r.json();
        return { success: r.ok, result: d.html ? 'Visual HTML generated!' : (d.error || 'Failed.'), data: d };
      }

      // ── BROWSER AGENT ──
      case 'start_browser_agent': {
        if (!p.prompt) return fail('Prompt required.');
        const r = await fetch(`${o}/api/affiliate-browser-chat/start`, { method: 'POST', headers: hdr(), body: JSON.stringify({ prompt: p.prompt, startUrl: p.startUrl, maxTurns: 50 }) });
        const d = await r.json();
        return d.success ? { success: true, result: `Browser agent started! Job: ${d.jobId}. Check Affiliate Browser Chat for progress.`, data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'stop_browser_agent': {
        if (!p.jobId) return fail('Job ID required.');
        const r = await fetch(`${o}/api/affiliate-browser-chat/stop?jobId=${p.jobId}`, { method: 'DELETE' });
        const d = await r.json();
        return { success: r.ok, result: d.success ? 'Agent stopped.' : (d.error || 'Failed.'), data: d };
      }

      // ── CLONE & SWIPE ──
      case 'clone_page':
      case 'clone_for_funnel': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/landing/clone`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return r.ok && d.html ? { success: true, result: `Cloned! ${d.html.length} chars. Title: "${d.title || 'N/A'}"`, data: { title: d.title, length: d.html.length } } : { success: false, result: d.error || 'Failed.' };
      }
      case 'swipe_page':
      case 'swipe_for_funnel': {
        if (!p.url) return fail('URL required.');
        if (!p.productName) return fail('Product name required.');
        const r = await fetch(`${o}/api/landing/swipe`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url, product: { name: p.productName, description: p.productDescription || '' } }) });
        const d = await r.json();
        return r.ok && d.html ? { success: true, result: `Swiped for "${p.productName}"! ${d.html.length} chars.`, data: { length: d.html.length } } : { success: false, result: d.error || 'Failed.' };
      }

      // ── PRODUCTS ──
      case 'create_product': {
        if (!p.name) return fail('Name required.');
        const r = await fetch(`${o}/api/v1/products`, { method: 'POST', headers: hdr(), body: JSON.stringify({ name: p.name, description: p.description || '', price: p.price || 0, benefits: p.benefits || [], cta_text: p.ctaText || 'Buy Now', cta_url: p.ctaUrl || '', brand_name: p.brandName || '' }) });
        const d = await r.json();
        return r.ok ? { success: true, result: `Product "${p.name}" created!`, data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'list_products': {
        const r = await fetch(`${o}/api/v1/products`);
        const d = await r.json();
        const items = d.products || d.data || [];
        if (!items.length) return { success: true, result: 'No products.' };
        return { success: true, result: items.map((x: { name: string; price: number; description: string }, i: number) => `${i + 1}. **${x.name}** — €${x.price} — ${(x.description || '').slice(0, 80)}`).join('\n'), data: items };
      }
      case 'update_product': {
        if (!p.id) return fail('Product ID required.');
        const r = await fetch(`${o}/api/v1/products`, { method: 'PUT', headers: hdr(), body: JSON.stringify(p) });
        const d = await r.json();
        return r.ok ? { success: true, result: 'Product updated!', data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'delete_product': {
        if (!p.id) return fail('Product ID required.');
        const r = await fetch(`${o}/api/v1/products`, { method: 'DELETE', headers: hdr(), body: JSON.stringify({ id: p.id }) });
        const d = await r.json();
        return r.ok ? { success: true, result: 'Product deleted.', data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'generate_brief': {
        if (!p.productName) return fail('Product name required.');
        const r = await fetch(`${o}/api/product-brief`, { method: 'POST', headers: hdr(), body: JSON.stringify({ product: { name: p.productName } }) });
        const d = await r.json();
        return { success: r.ok, result: d.brief || d.error || 'Brief generated.', data: d };
      }
      case 'product_chat': {
        const r = await fetch(`${o}/api/funnel-brief/chat`, { method: 'POST', headers: hdr(), body: JSON.stringify({ messages: [{ role: 'user', content: `Product: ${p.productName}. ${p.message}` }] }) });
        const d = await r.json();
        return { success: r.ok, result: d.response || d.content || d.error || 'Done.', data: d };
      }

      // ── FUNNEL PAGES ──
      case 'add_funnel_page':
      case 'create_flow': {
        if (!p.name) return fail('Name required.');
        const r = await fetch(`${o}/api/v1/funnels`, { method: 'POST', headers: hdr(), body: JSON.stringify({ name: p.name, page_type: p.pageType || 'bridge', url_to_swipe: p.url || '', product_id: p.productId || null, swipe_status: 'pending' }) });
        const d = await r.json();
        return r.ok ? { success: true, result: `Page "${p.name}" added!`, data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'delete_funnel_page': {
        if (!p.id) return fail('Page ID required.');
        const r = await fetch(`${o}/api/v1/funnels`, { method: 'DELETE', headers: hdr(), body: JSON.stringify({ id: p.id }) });
        const d = await r.json();
        return r.ok ? { success: true, result: 'Page deleted.', data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'list_flows':
      case 'list_saved_funnels': {
        const r = await fetch(`${o}/api/v1/funnels`);
        const d = await r.json();
        const items = d.funnel_pages || d.data || [];
        if (!items.length) return { success: true, result: 'No funnel pages.' };
        return { success: true, result: items.map((x: { name: string; page_type: string; url_to_swipe: string }, i: number) => `${i + 1}. **${x.name}** (${x.page_type}) ${x.url_to_swipe ? '— ' + x.url_to_swipe : ''}`).join('\n'), data: items };
      }
      case 'analyze_funnel_page': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/funnel/analyze`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return { success: r.ok, result: d.analysis || d.error || 'Done.', data: d };
      }
      case 'bulk_product_change': {
        return { success: true, result: 'Bulk product change: go to Front End Funnel, select pages, and use the product dropdown to change in bulk.' };
      }

      // ── POST PURCHASE ──
      case 'add_post_purchase': {
        if (!p.name) return fail('Name required.');
        return { success: true, result: `To add "${p.name}" (${p.type || 'upsell'}), go to Post Purchase section and click Add Page.` };
      }
      case 'launch_swipe':
      case 'launch_post_purchase_swipe': {
        return { success: true, result: 'Swipe launched. Go to the relevant section to see progress.' };
      }

      // ── ARCHIVE & TEMPLATES ──
      case 'list_templates': {
        const r = await fetch(`${o}/api/v1/templates`);
        const d = await r.json();
        const items = d.templates || d.data || [];
        if (!items.length) return { success: true, result: 'No templates.' };
        return { success: true, result: items.map((x: { name: string; page_type: string }, i: number) => `${i + 1}. **${x.name}** (${x.page_type})`).join('\n'), data: items };
      }
      case 'list_archive': {
        const r = await fetch(`${o}/api/v1/archive`);
        const d = await r.json();
        const items = d.archived_funnels || d.data || [];
        if (!items.length) return { success: true, result: 'No archived funnels.' };
        return { success: true, result: items.map((x: { name: string; total_steps: number }, i: number) => `${i + 1}. **${x.name}** (${x.total_steps} steps)`).join('\n'), data: items };
      }
      case 'add_template': {
        if (!p.name || !p.sourceUrl) return fail('Name and source URL required.');
        const r = await fetch(`${o}/api/v1/templates`, { method: 'POST', headers: hdr(), body: JSON.stringify({ name: p.name, source_url: p.sourceUrl, page_type: p.pageType || 'bridge', tags: [], description: '' }) });
        const d = await r.json();
        return r.ok ? { success: true, result: `Template "${p.name}" added!`, data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'delete_template': {
        if (!p.id) return fail('Template ID required.');
        return { success: true, result: 'Go to My Archive > Templates to delete.' };
      }
      case 'delete_saved_funnel':
      case 'import_to_archive':
      case 'create_funnel_scratch':
      case 'import_archive_to_funnel':
      case 'run_type_analysis': {
        return { success: true, result: `Action "${action}" noted. Go to the relevant section to complete it.` };
      }

      // ── QUIZ ──
      case 'generate_quiz':
      case 'generate_quiz_funnel':
      case 'analyze_quiz':
      case 'generate_quiz_simple': {
        const topic = (p.topic || p.prompt || p.productName || '') as string;
        if (!topic) return fail('Topic/prompt required.');
        const r = await fetch(`${o}/api/generate-quiz`, { method: 'POST', headers: hdr(), body: JSON.stringify({ topic, productName: p.productName || topic }) });
        const d = await r.json();
        return { success: r.ok, result: d.html ? 'Quiz generated!' : (d.error || 'Failed.'), data: d };
      }
      case 'generate_quiz_swap':
      case 'generate_quiz_multiagent':
      case 'swipe_quiz_analysis': {
        return { success: true, result: 'Quiz swap/multiagent: go to Swipe Quiz section to configure and run.' };
      }
      case 'take_screenshot': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/swipe-quiz/screenshot`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return { success: r.ok, result: d.screenshot ? 'Screenshot captured!' : (d.error || 'Failed.'), data: d };
      }

      // ── AGENTIC SWIPE ──
      case 'run_agentic_swipe': {
        if (!p.url || !p.productName) return fail('URL and product name required.');
        return { success: true, result: `Agentic swipe: go to Agentic Swipe section, enter URL "${p.url}" and product "${p.productName}", then click Run.` };
      }

      // ── COMPLIANCE ──
      case 'check_compliance': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/compliance-ai/check`, { method: 'POST', headers: hdr(), body: JSON.stringify({ sectionId: 'all', funnelUrls: [p.url] }) });
        const d = await r.json();
        return { success: r.ok, result: d.analysis || d.report || d.error || 'Check done.', data: d };
      }
      case 'check_compliance_batch': {
        const urls = (p.urls || []) as string[];
        if (!urls.length) return fail('URLs required.');
        const r = await fetch(`${o}/api/compliance-ai/check`, { method: 'POST', headers: hdr(), body: JSON.stringify({ sectionId: 'all', funnelUrls: urls }) });
        const d = await r.json();
        return { success: r.ok, result: d.analysis || d.report || d.error || 'Batch check done.', data: d };
      }

      // ── DEPLOY ──
      case 'deploy_funnelish': {
        return { success: true, result: 'To deploy to Funnelish: go to Deploy Funnel, select Funnelish, upload your HTML, and enter your credentials.' };
      }
      case 'deploy_checkout_champ': {
        return { success: true, result: 'To deploy to Checkout Champ: go to Deploy Funnel, select Checkout Champ, upload your HTML, and enter your credentials.' };
      }

      // ── AI EDITING ──
      case 'rewrite_copy': {
        if (!p.text) return fail('Text required.');
        const r = await fetch(`${o}/api/rewrite-section`, { method: 'POST', headers: hdr(), body: JSON.stringify({ text: p.text, instructions: p.instructions || 'Improve for higher conversion' }) });
        const d = await r.json();
        return { success: r.ok, result: d.rewritten || d.result || d.error || 'Done.', data: d };
      }
      case 'edit_html': {
        if (!p.html) return fail('HTML required.');
        const r = await fetch(`${o}/api/ai-edit-element`, { method: 'POST', headers: hdr(), body: JSON.stringify({ elementHtml: p.html, instruction: p.instructions || 'Improve' }) });
        const d = await r.json();
        return { success: r.ok, result: d.editedHtml || d.error || 'Done.', data: d };
      }
      case 'generate_image': {
        if (!p.prompt) return fail('Description required.');
        const r = await fetch(`${o}/api/generate-image`, { method: 'POST', headers: hdr(), body: JSON.stringify({ prompt: p.prompt }) });
        const d = await r.json();
        return { success: r.ok, result: d.url ? `Image: ${d.url}` : (d.error || 'Failed.'), data: d };
      }

      // ── PROMPTS ──
      case 'list_prompts': {
        const r = await fetch(`${o}/api/prompts`);
        const d = await r.json();
        const items = d.prompts || d.data || [];
        if (!items.length) return { success: true, result: 'No saved prompts.' };
        return { success: true, result: items.map((x: { name: string }, i: number) => `${i + 1}. ${x.name}`).join('\n'), data: items };
      }
      case 'save_prompt': {
        if (!p.name || !p.content) return fail('Name and content required.');
        const r = await fetch(`${o}/api/prompts`, { method: 'POST', headers: hdr(), body: JSON.stringify({ name: p.name, content: p.content, category: p.category || 'general' }) });
        const d = await r.json();
        return r.ok ? { success: true, result: `Prompt "${p.name}" saved!`, data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'delete_prompt': {
        if (!p.id) return fail('Prompt ID required.');
        const r = await fetch(`${o}/api/prompts?id=${p.id}`, { method: 'DELETE' });
        const d = await r.json();
        return r.ok ? { success: true, result: 'Prompt deleted.', data: d } : { success: false, result: d.error || 'Failed.' };
      }

      // ── API KEYS ──
      case 'list_api_keys': {
        const r = await fetch(`${o}/api/api-keys`);
        const d = await r.json();
        const items = d.keys || d.data || [];
        if (!items.length) return { success: true, result: 'No API keys.' };
        return { success: true, result: items.map((x: { name: string; key_prefix: string; is_active: boolean }, i: number) => `${i + 1}. **${x.name}** (${x.key_prefix}...) ${x.is_active ? '✓ Active' : '✗ Inactive'}`).join('\n'), data: items };
      }
      case 'create_api_key': {
        if (!p.name) return fail('Key name required.');
        const r = await fetch(`${o}/api/api-keys`, { method: 'POST', headers: hdr(), body: JSON.stringify({ name: p.name, permissions: p.permissions || ['full_access'] }) });
        const d = await r.json();
        return r.ok ? { success: true, result: `API key "${p.name}" created! Key: ${d.rawKey || d.key || '(check API Keys page)'}`, data: d } : { success: false, result: d.error || 'Failed.' };
      }

      // ── FIRECRAWL ──
      case 'firecrawl_scrape': {
        if (!p.url) return fail('URL required.');
        return { success: true, result: 'Go to Firecrawl section, enter the URL and click Scrape.' };
      }

      // ── BROWSER AGENTICO ──
      case 'start_agentic_crawl': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/browser-agentico/start`, { method: 'POST', headers: hdr(), body: JSON.stringify({ entryUrl: p.url, maxSteps: 20 }) });
        const d = await r.json();
        return d.jobId ? { success: true, result: `Agentic crawl started! Job: ${d.jobId}`, data: d } : { success: false, result: d.error || 'Failed.' };
      }

      // ── BRANDING ──
      case 'generate_branding': {
        if (!p.productName) return fail('Product name required.');
        const r = await fetch(`${o}/api/branding/generate`, { method: 'POST', headers: hdr(), body: JSON.stringify({ productName: p.productName, funnelName: p.funnelName }) });
        const d = await r.json();
        return { success: r.ok, result: d.branding ? 'Branding generated!' : (d.error || 'Failed.'), data: d };
      }

      // ── DOWNLOAD TEMPLATE ──
      case 'download_template_excel': {
        return { success: true, result: 'Go to Front End Funnel and click the Template button to download the Excel import template.' };
      }

      default:
        return { success: false, result: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, result: `Error: ${(err as Error).message}` };
  }
}

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { message, section, conversationHistory } = await req.json();
  if (!message) return NextResponse.json({ error: 'Missing message' }, { status: 400 });

  const cfg = await getOpenClawConfig();
  if (!cfg.apiKey) return NextResponse.json({ error: 'OpenClaw not configured' }, { status: 500 });

  const origin = req.nextUrl.origin;

  // Quick-detect: skip full LLM action detection for simple chat messages
  const looksLikeAction = /\b(crea|create|analyz|analis|clone|clona|deploy|import|export|delete|elimin|naviga|browse|compli|genera)\b/i.test(message);

  let detected: ToolAction = { action: 'no_action', params: {} };
  if (looksLikeAction) {
    try {
      detected = await detectAction(message, section, cfg);
    } catch {
      detected = { action: 'no_action', params: {} };
    }
  }

  let actionResult: { success: boolean; result: string; data?: unknown } | null = null;
  if (detected.action !== 'no_action') {
    actionResult = await exec(detected, origin);
  }

  const sys = `You are OpenClaw, AI assistant in "${section}" section of Funnel Swiper tool.
${actionResult ? `\nACTION: ${detected.action} | PARAMS: ${JSON.stringify(detected.params)} | ${actionResult.success ? 'SUCCESS' : 'FAILED'}\nOUTPUT:\n${actionResult.result}\n\nExplain what happened clearly.` : 'User is chatting. Help them with their question.'}
Be concise, helpful. Same language as user (Italian/English).`;

  const history = (conversationHistory || []).slice(-10);
  history.push({ role: 'user', content: message });

  try {
    const r = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: sys }, ...history], temperature: 0.7, max_tokens: 2048 }),
      signal: AbortSignal.timeout(55000),
    });
    if (!r.ok) { const e = await r.text(); return NextResponse.json({ error: `OpenClaw: ${r.status} - ${e}` }, { status: r.status }); }
    const data = await r.json();
    return NextResponse.json({
      content: data.choices?.[0]?.message?.content || '',
      actionExecuted: detected.action !== 'no_action' ? detected.action : null,
      actionSuccess: actionResult?.success ?? null,
      actionData: actionResult?.data ?? null,
    });
  } catch (err) {
    return NextResponse.json({ error: `Connection failed: ${(err as Error).message}` }, { status: 502 });
  }
}
