import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const maxDuration = 60;

const OPENCLAW_BASE_URL = process.env.OPENCLAW_BASE_URL || 'http://38.247.186.84:19001';
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY || 'a353475b70538480030b744771524d183521a46ab8db7b02a2846d1103bc5734';
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || 'merlino';

interface ToolAction {
  action: string;
  params: Record<string, unknown>;
}

function hdr() { return { 'Content-Type': 'application/json' }; }
function fail(msg: string) { return { success: false, result: msg }; }

const ACTION_PATTERNS: { pattern: RegExp; action: string; extract: (m: RegExpMatchArray, msg: string) => Record<string, unknown> }[] = [
  // Products
  { pattern: /\b(crea|create|aggiungi|add)\b.*\b(prodotto|product)\b.*["""](.+?)["""]/i, action: 'create_product', extract: (_m, msg) => {
    const nameM = msg.match(/["""](.+?)["""]/); const priceM = msg.match(/(\d+(?:[.,]\d+)?)\s*[€$]/);
    return { name: nameM?.[1] || '', price: priceM ? parseFloat(priceM[1].replace(',', '.')) : 0 };
  }},
  { pattern: /\b(lista|list|elenca|mostra|show)\b.*\b(prodott|product)/i, action: 'list_products', extract: () => ({}) },
  { pattern: /\b(elimina|delete|rimuovi|remove)\b.*\b(prodotto|product)\b/i, action: 'delete_product', extract: (_m, msg) => {
    const idM = msg.match(/id[:\s]+([a-f0-9-]+)/i); return { id: idM?.[1] || '' };
  }},

  // Projects
  { pattern: /\b(crea|create|aggiungi|add)\b.*\b(progetto|project)\b/i, action: 'create_project', extract: (_m, msg) => {
    const nameM = msg.match(/["""](.+?)["""]/); return { name: nameM?.[1] || 'New Project' };
  }},
  { pattern: /\b(lista|list|elenca|mostra|show)\b.*\b(progett|project)/i, action: 'list_projects', extract: () => ({}) },
  { pattern: /\b(elimina|delete|rimuovi|remove)\b.*\b(progetto|project)\b/i, action: 'delete_project', extract: (_m, msg) => {
    const idM = msg.match(/id[:\s]+([a-f0-9-]+)/i); return { id: idM?.[1] || '' };
  }},
  { pattern: /\b(aggiorna|update|modifica|edit)\b.*\b(progetto|project)\b/i, action: 'update_project', extract: (_m, msg) => {
    const idM = msg.match(/id[:\s]+([a-f0-9-]+)/i); const nameM = msg.match(/["""](.+?)["""]/);
    return { id: idM?.[1] || '', name: nameM?.[1] };
  }},

  // Funnel pages
  { pattern: /\b(crea|create|aggiungi|add)\b.*\b(pagina|page|funnel)\b/i, action: 'add_funnel_page', extract: (_m, msg) => {
    const nameM = msg.match(/["""](.+?)["""]/); const urlM = msg.match(/(https?:\/\/[^\s"]+)/i);
    return { name: nameM?.[1] || 'New Page', url: urlM?.[1] || '' };
  }},
  { pattern: /\b(lista|list|elenca|mostra|show)\b.*\b(pagin|page|funnel)/i, action: 'list_flows', extract: () => ({}) },
  { pattern: /\b(elimina|delete|rimuovi|remove)\b.*\b(pagina|page)\b/i, action: 'delete_funnel_page', extract: (_m, msg) => {
    const idM = msg.match(/id[:\s]+([a-f0-9-]+)/i); return { id: idM?.[1] || '' };
  }},

  // Templates / Archive
  { pattern: /\b(lista|list|elenca|mostra|show)\b.*\b(template|archiv)/i, action: 'list_templates', extract: () => ({}) },
  { pattern: /\b(lista|list|elenca|mostra|show)\b.*\b(archiv|salvat|saved)/i, action: 'list_archive', extract: () => ({}) },

  // Clone & Swipe
  { pattern: /\b(clon[ae]|clone)\b.*?(https?:\/\/[^\s"]+)/i, action: 'clone_page', extract: (m) => ({ url: m[2] }) },
  { pattern: /\b(swipe|swipa|riscrivi|rewrite)\b.*?(https?:\/\/[^\s"]+)/i, action: 'swipe_page', extract: (m, msg) => {
    const prodM = msg.match(/prodotto?\s+["""](.+?)["""]/i) || msg.match(/product\s+["""](.+?)["""]/i);
    return { url: m[2], productName: prodM?.[1] || '' };
  }},

  // Analysis
  { pattern: /\b(analiz|analy[sz])\b.*?(https?:\/\/[^\s"]+)/i, action: 'full_analysis_landing', extract: (m) => ({ url: m[2] }) },
  { pattern: /\b(crawl|scansiona|scansion)\b.*?(https?:\/\/[^\s"]+)/i, action: 'crawl_funnel', extract: (m) => ({ url: m[2] }) },
  { pattern: /\b(reverse|inverti|decostruisci)\b.*?(https?:\/\/[^\s"]+)/i, action: 'reverse_funnel', extract: (m) => ({ url: m[2] }) },

  // Compliance
  { pattern: /\b(compliance|conformità|ftc)\b.*?(https?:\/\/[^\s"]+)/i, action: 'check_compliance', extract: (m) => ({ url: m[2] }) },

  // Browser Agent
  { pattern: /\b(naviga|browse|apri|open|vai)\b.*?(https?:\/\/[^\s"]+)/i, action: 'start_browser_agent', extract: (m, msg) => ({ prompt: msg, startUrl: m[2] }) },

  // Quiz
  { pattern: /\b(genera|generate|crea|create)\b.*\b(quiz)\b/i, action: 'generate_quiz', extract: (_m, msg) => {
    const topicM = msg.match(/["""](.+?)["""]/); return { topic: topicM?.[1] || msg };
  }},

  // Image
  { pattern: /\b(genera|generate|crea|create)\b.*\b(immagine|image|foto|photo)\b/i, action: 'generate_image', extract: (_m, msg) => ({ prompt: msg }) },

  // Branding
  { pattern: /\b(genera|generate|crea|create)\b.*\b(branding|brand)\b/i, action: 'generate_branding', extract: (_m, msg) => {
    const nameM = msg.match(/["""](.+?)["""]/); return { productName: nameM?.[1] || '' };
  }},

  // Brief
  { pattern: /\b(genera|generate|crea|create)\b.*\b(brief)\b/i, action: 'generate_brief', extract: (_m, msg) => {
    const nameM = msg.match(/["""](.+?)["""]/); return { productName: nameM?.[1] || '' };
  }},

  // Copy rewrite
  { pattern: /\b(riscrivi|rewrite|migliora|improve)\b.*\b(copy|testo|text)\b/i, action: 'rewrite_copy', extract: (_m, msg) => ({ text: msg }) },

  // Deploy
  { pattern: /\b(deploy|pubblica|publish)\b.*\b(funnelish)\b/i, action: 'deploy_funnelish', extract: () => ({}) },
  { pattern: /\b(deploy|pubblica|publish)\b.*\b(checkout\s*champ)\b/i, action: 'deploy_checkout_champ', extract: () => ({}) },

  // Screenshot
  { pattern: /\b(screenshot|screen)\b.*?(https?:\/\/[^\s"]+)/i, action: 'take_screenshot', extract: (m) => ({ url: m[2] }) },

  // API Keys
  { pattern: /\b(lista|list|mostra|show)\b.*\b(api\s*key)/i, action: 'list_api_keys', extract: () => ({}) },
  { pattern: /\b(crea|create)\b.*\b(api\s*key)\b/i, action: 'create_api_key', extract: (_m, msg) => {
    const nameM = msg.match(/["""](.+?)["""]/); return { name: nameM?.[1] || 'New Key' };
  }},

  // Prompts
  { pattern: /\b(lista|list|mostra|show)\b.*\b(prompt)/i, action: 'list_prompts', extract: () => ({}) },
];

function detectAction(message: string): ToolAction {
  for (const p of ACTION_PATTERNS) {
    const m = message.match(p.pattern);
    if (m) {
      return { action: p.action, params: p.extract(m, message) };
    }
  }
  return { action: 'no_action', params: {} };
}

async function callMerlinoOnce(messages: { role: string; content: string }[], timeoutMs: number) {
  const url = `${OPENCLAW_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENCLAW_API_KEY}` },
    body: JSON.stringify({ model: OPENCLAW_MODEL, messages, temperature: 0.7, max_tokens: 4096 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenClaw HTTP ${res.status}: ${body.substring(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}


async function exec(a: ToolAction, o: string): Promise<{ success: boolean; result: string; data?: unknown }> {
  const { action, params: p } = a;
  try {
    switch (action) {
      case 'analyze_copy': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/analyze-copy`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return { success: r.ok, result: d.analysis || d.error || 'Done.', data: d };
      }
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
      case 'crawl_funnel': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/funnel-analyzer/crawl/start`, { method: 'POST', headers: hdr(), body: JSON.stringify({ entryUrl: p.url, maxSteps: p.maxSteps || 20, quizMode: p.quizMode || false }) });
        const d = await r.json();
        return d.jobId ? { success: true, result: `Crawl avviato! Job: ${d.jobId}. Controlla Funnel Analyzer.`, data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'vision_funnel': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/funnel-analyzer/vision-from-saved`, { method: 'POST', headers: hdr(), body: JSON.stringify({ entryUrl: p.url, funnelName: p.funnelName || '', provider: 'gemini' }) });
        const d = await r.json();
        return { success: r.ok, result: d.analyses ? `Vision analysis per ${d.analyses.length} step.` : (d.error || 'Done.'), data: d };
      }
      case 'reverse_funnel': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/reverse-funnel/analyze`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return { success: r.ok, result: d.analysis || d.error || 'Reverse analysis done.', data: d };
      }
      case 'start_browser_agent': {
        if (!p.prompt) return fail('Prompt required.');
        const r = await fetch(`${o}/api/affiliate-browser-chat/start`, { method: 'POST', headers: hdr(), body: JSON.stringify({ prompt: p.prompt, startUrl: p.startUrl, maxTurns: 50 }) });
        const d = await r.json();
        return d.success ? { success: true, result: `Browser agent avviato! Job: ${d.jobId}`, data: d } : { success: false, result: d.error || 'Failed.' };
      }
      case 'stop_browser_agent': {
        if (!p.jobId) return fail('Job ID required.');
        const r = await fetch(`${o}/api/affiliate-browser-chat/stop?jobId=${p.jobId}`, { method: 'DELETE' });
        const d = await r.json();
        return { success: r.ok, result: d.success ? 'Agent fermato.' : (d.error || 'Failed.'), data: d };
      }
      case 'clone_page': {
        if (!p.url) return fail('URL required.');
        const r = await fetch(`${o}/api/landing/clone`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return r.ok && d.html ? { success: true, result: `Clonato! ${d.html.length} caratteri. Titolo: "${d.title || 'N/A'}"`, data: { title: d.title, length: d.html.length } } : { success: false, result: d.error || 'Failed.' };
      }
      case 'swipe_page': {
        if (!p.url) return fail('URL required.');
        if (!p.productName) return fail('Serve il nome del prodotto.');
        const r = await fetch(`${o}/api/landing/swipe`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url, product: { name: p.productName, description: p.productDescription || '' } }) });
        const d = await r.json();
        return r.ok && d.html ? { success: true, result: `Swipato per "${p.productName}"! ${d.html.length} caratteri.`, data: { length: d.html.length } } : { success: false, result: d.error || 'Failed.' };
      }

      // Products (direct Supabase)
      case 'create_product': {
        if (!p.name) return fail('Nome prodotto richiesto.');
        const { data: d, error: e } = await supabase.from('products').insert({ name: p.name, description: p.description || '', price: p.price || 0, benefits: p.benefits || [], cta_text: p.ctaText || 'Buy Now', cta_url: p.ctaUrl || '', brand_name: p.brandName || '' }).select().single();
        return e ? fail(e.message) : { success: true, result: `Prodotto "${p.name}" creato!`, data: d };
      }
      case 'list_products': {
        const { data: items, error: e } = await supabase.from('products').select('*').order('created_at', { ascending: false });
        if (e) return fail(e.message);
        if (!items?.length) return { success: true, result: 'Nessun prodotto.' };
        return { success: true, result: items.map((x: { name: string; price: number; description: string }, i: number) => `${i + 1}. **${x.name}** — €${x.price} — ${(x.description || '').slice(0, 80)}`).join('\n'), data: items };
      }
      case 'update_product': {
        if (!p.id) return fail('Product ID richiesto.');
        const { id, ...updates } = p;
        const { data: d, error: e } = await supabase.from('products').update(updates).eq('id', id).select().single();
        return e ? fail(e.message) : { success: true, result: 'Prodotto aggiornato!', data: d };
      }
      case 'delete_product': {
        if (!p.id) return fail('Product ID richiesto.');
        const { error: e } = await supabase.from('products').delete().eq('id', p.id);
        return e ? fail(e.message) : { success: true, result: 'Prodotto eliminato.' };
      }
      case 'generate_brief': {
        if (!p.productName) return fail('Nome prodotto richiesto.');
        const r = await fetch(`${o}/api/product-brief`, { method: 'POST', headers: hdr(), body: JSON.stringify({ product: { name: p.productName } }) });
        const d = await r.json();
        return { success: r.ok, result: d.brief || d.error || 'Brief generato.', data: d };
      }

      // Projects (direct Supabase)
      case 'create_project': {
        if (!p.name) return fail('Nome progetto richiesto.');
        const { data: d, error: e } = await supabase.from('projects').insert({ name: p.name, description: p.description || '', status: p.status || 'draft', tags: p.tags || [], notes: p.notes || '' }).select().single();
        return e ? fail(e.message) : { success: true, result: `Progetto "${p.name}" creato!`, data: d };
      }
      case 'list_projects': {
        const { data: items, error: e } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
        if (e) return fail(e.message);
        if (!items?.length) return { success: true, result: 'Nessun progetto.' };
        return { success: true, result: items.map((x: { name: string; status: string; description: string }, i: number) => `${i + 1}. **${x.name}** [${x.status}] — ${(x.description || '').slice(0, 80)}`).join('\n'), data: items };
      }
      case 'update_project': {
        if (!p.id) return fail('Project ID richiesto.');
        const { id, ...updates } = p;
        const { data: d, error: e } = await supabase.from('projects').update(updates).eq('id', id).select().single();
        return e ? fail(e.message) : { success: true, result: 'Progetto aggiornato!', data: d };
      }
      case 'delete_project': {
        if (!p.id) return fail('Project ID richiesto.');
        const { error: e } = await supabase.from('projects').delete().eq('id', p.id);
        return e ? fail(e.message) : { success: true, result: 'Progetto eliminato.' };
      }

      // Funnel Pages (direct Supabase)
      case 'add_funnel_page': {
        if (!p.name) return fail('Nome pagina richiesto.');
        const { data: d, error: e } = await supabase.from('funnel_pages').insert({ name: p.name, page_type: p.pageType || 'bridge', url_to_swipe: p.url || '', product_id: p.productId || null, swipe_status: 'pending' }).select().single();
        return e ? fail(e.message) : { success: true, result: `Pagina "${p.name}" aggiunta!`, data: d };
      }
      case 'delete_funnel_page': {
        if (!p.id) return fail('Page ID richiesto.');
        const { error: e } = await supabase.from('funnel_pages').delete().eq('id', p.id);
        return e ? fail(e.message) : { success: true, result: 'Pagina eliminata.' };
      }
      case 'list_flows': {
        const { data: items, error: e } = await supabase.from('funnel_pages').select('*').order('created_at', { ascending: false });
        if (e) return fail(e.message);
        if (!items?.length) return { success: true, result: 'Nessuna pagina funnel.' };
        return { success: true, result: items.map((x: { name: string; page_type: string; url_to_swipe: string }, i: number) => `${i + 1}. **${x.name}** (${x.page_type}) ${x.url_to_swipe ? '— ' + x.url_to_swipe : ''}`).join('\n'), data: items };
      }

      // Templates & Archive (direct Supabase)
      case 'list_templates': {
        const { data: items, error: e } = await supabase.from('swipe_templates').select('*').order('created_at', { ascending: false });
        if (e) return fail(e.message);
        if (!items?.length) return { success: true, result: 'Nessun template.' };
        return { success: true, result: items.map((x: { name: string; page_type: string }, i: number) => `${i + 1}. **${x.name}** (${x.page_type})`).join('\n'), data: items };
      }
      case 'list_archive': {
        const { data: items, error: e } = await supabase.from('archived_funnels').select('*').order('created_at', { ascending: false });
        if (e) return fail(e.message);
        if (!items?.length) return { success: true, result: 'Nessun funnel archiviato.' };
        return { success: true, result: items.map((x: { name: string; total_steps: number }, i: number) => `${i + 1}. **${x.name}** (${x.total_steps} step)`).join('\n'), data: items };
      }

      // Compliance
      case 'check_compliance': {
        if (!p.url) return fail('URL richiesto.');
        const r = await fetch(`${o}/api/compliance-ai/check`, { method: 'POST', headers: hdr(), body: JSON.stringify({ sectionId: 'all', funnelUrls: [p.url] }) });
        const d = await r.json();
        return { success: r.ok, result: d.analysis || d.report || d.error || 'Check completato.', data: d };
      }

      // Quiz
      case 'generate_quiz': {
        const topic = (p.topic || p.prompt || '') as string;
        if (!topic) return fail('Topic richiesto.');
        const r = await fetch(`${o}/api/generate-quiz`, { method: 'POST', headers: hdr(), body: JSON.stringify({ topic, productName: p.productName || topic }) });
        const d = await r.json();
        return { success: r.ok, result: d.html ? 'Quiz generato!' : (d.error || 'Failed.'), data: d };
      }

      // Image
      case 'generate_image': {
        if (!p.prompt) return fail('Descrizione richiesta.');
        const r = await fetch(`${o}/api/generate-image`, { method: 'POST', headers: hdr(), body: JSON.stringify({ prompt: p.prompt }) });
        const d = await r.json();
        return { success: r.ok, result: d.url ? `Immagine generata: ${d.url}` : (d.error || 'Failed.'), data: d };
      }

      // Branding
      case 'generate_branding': {
        if (!p.productName) return fail('Nome prodotto richiesto.');
        const r = await fetch(`${o}/api/branding/generate`, { method: 'POST', headers: hdr(), body: JSON.stringify({ productName: p.productName, funnelName: p.funnelName }) });
        const d = await r.json();
        return { success: r.ok, result: d.branding ? 'Branding generato!' : (d.error || 'Failed.'), data: d };
      }

      // Copy rewrite
      case 'rewrite_copy': {
        if (!p.text) return fail('Testo richiesto.');
        const r = await fetch(`${o}/api/rewrite-section`, { method: 'POST', headers: hdr(), body: JSON.stringify({ text: p.text, instructions: p.instructions || 'Migliora per alta conversione' }) });
        const d = await r.json();
        return { success: r.ok, result: d.rewritten || d.result || d.error || 'Done.', data: d };
      }

      // Screenshot
      case 'take_screenshot': {
        if (!p.url) return fail('URL richiesto.');
        const r = await fetch(`${o}/api/swipe-quiz/screenshot`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: p.url }) });
        const d = await r.json();
        return { success: r.ok, result: d.screenshot ? 'Screenshot catturato!' : (d.error || 'Failed.'), data: d };
      }

      // API Keys
      case 'list_api_keys': {
        const r = await fetch(`${o}/api/api-keys`);
        const d = await r.json();
        const items = d.keys || d.data || [];
        if (!items.length) return { success: true, result: 'Nessuna API key.' };
        return { success: true, result: items.map((x: { name: string; key_prefix: string; is_active: boolean }, i: number) => `${i + 1}. **${x.name}** (${x.key_prefix}...) ${x.is_active ? 'Attiva' : 'Inattiva'}`).join('\n'), data: items };
      }
      case 'create_api_key': {
        if (!p.name) return fail('Nome key richiesto.');
        const r = await fetch(`${o}/api/api-keys`, { method: 'POST', headers: hdr(), body: JSON.stringify({ name: p.name, permissions: p.permissions || ['full_access'] }) });
        const d = await r.json();
        return r.ok ? { success: true, result: `API key "${p.name}" creata! Key: ${d.rawKey || d.key || '(vedi pagina API Keys)'}`, data: d } : { success: false, result: d.error || 'Failed.' };
      }

      // Prompts
      case 'list_prompts': {
        const r = await fetch(`${o}/api/prompts`);
        const d = await r.json();
        const items = d.prompts || d.data || [];
        if (!items.length) return { success: true, result: 'Nessun prompt salvato.' };
        return { success: true, result: items.map((x: { name: string }, i: number) => `${i + 1}. ${x.name}`).join('\n'), data: items };
      }

      // Deploy
      case 'deploy_funnelish': return { success: true, result: 'Per deployare su Funnelish: vai a Deploy Funnel, seleziona Funnelish, carica l\'HTML e inserisci le credenziali.' };
      case 'deploy_checkout_champ': return { success: true, result: 'Per deployare su Checkout Champ: vai a Deploy Funnel, seleziona Checkout Champ, carica l\'HTML e inserisci le credenziali.' };

      default:
        return { success: false, result: `Azione sconosciuta: ${action}` };
    }
  } catch (err) {
    return { success: false, result: `Errore: ${(err as Error).message}` };
  }
}

export async function POST(req: NextRequest) {
  try {
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { messages, systemPrompt } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'Missing messages' }, { status: 400 });
  }

  const lastUserMsg = [...messages].reverse().find((m: { role: string }) => m.role === 'user');
  const userText = lastUserMsg?.content || '';
  const origin = req.nextUrl.origin;

  const detected = detectAction(userText);

  let actionResult: { success: boolean; result: string; data?: unknown } | null = null;
  if (detected.action !== 'no_action') {
    actionResult = await exec(detected, origin);
    return NextResponse.json({
      content: actionResult.result,
      actionExecuted: detected.action,
      actionSuccess: actionResult.success,
      actionData: actionResult.data,
      model: 'local',
    });
  }

  // No action — proxy chat to Merlino (only Merlino, no fallback)
  const openclawMessages: { role: string; content: string }[] = [];
  if (systemPrompt) {
    openclawMessages.push({ role: 'system', content: systemPrompt });
  }
  for (const m of messages) {
    if (m.role !== 'system') {
      openclawMessages.push({ role: m.role, content: m.content });
    }
  }

  const content = await callMerlinoOnce(openclawMessages, 55_000);
  return NextResponse.json({ content, model: OPENCLAW_MODEL });
  } catch (outerErr) {
    console.error('[action] Unhandled error:', outerErr);
    return NextResponse.json(
      { error: `Server error: ${(outerErr as Error).message}` },
      { status: 500 },
    );
  }
}
