// worker-lib/build-prompts.js
//
// Port JS puro di src/app/api/landing/swipe/openclaw-build-prompts/route.ts.
// Costruisce systemPrompt + userMessage per il rewrite ZERO calls HTTP.
//
// Input:
//   { html, sourceUrl?, product, tone?, language?, knowledge? }
// Output:
//   { systemPrompt, userMessage, texts, totalTexts, productName, originalTitle, knowledgeIncluded }

const { extractAllTextsUniversal } = require('./text-extractor');
const { getCoreKnowledge, getKnowledgeForTask } = require('./knowledge-kb');

const SAFE_TAG_CONTEXT = new Set(['title', 'meta:content', 'noscript', 'js-bundle']);
const SAFE_TAG_PREFIXES = [
  'tag:h1','tag:h2','tag:h3','tag:h4','tag:h5','tag:h6',
  'tag:p','tag:li','tag:td','tag:th','tag:dt','tag:dd',
  'tag:button','tag:a','tag:label','tag:figcaption',
  'tag:blockquote','tag:summary','tag:legend','tag:option',
  'tag:span','tag:strong','tag:em','tag:b','tag:i','tag:u',
  'tag:small','tag:mark','tag:cite','tag:q','tag:abbr',
  'mixed:p','mixed:div','mixed:li','mixed:td','mixed:th',
  'mixed:h1','mixed:h2','mixed:h3','mixed:h4','mixed:h5','mixed:h6',
  'mixed:span','mixed:strong','mixed:em','mixed:a','mixed:b','mixed:i',
  'attr:alt','attr:title','attr:placeholder','attr:aria-label','attr:value',
  // SPA JSON / JSON-LD: testi nascosti dentro <script type="application/json">
  // o dentro __NEXT_DATA__ / __NUXT__ / __sveltekit_data che sono i veri
  // contenitori del copy su SPA come Nooro, Bioma, Typeform-like, ecc.
  'spa-json:',
  'json-ld:',
  'meta:',
];
function isSafeContext(ctx) {
  if (SAFE_TAG_CONTEXT.has(ctx)) return true;
  return SAFE_TAG_PREFIXES.some((p) => ctx === p || ctx.startsWith(p + ':') || (p.endsWith(':') && ctx.startsWith(p)));
}

const MAX_TEXTS_FOR_AI = Math.max(
  50,
  Math.min(800, parseInt(process.env.SWIPE_MAX_TEXTS_FOR_AI || '350', 10) || 350),
);

const TAG_PRIORITY = {
  title: 0,
  h1: 1, h2: 1, h3: 2, h4: 3, h5: 4, h6: 4,
  p: 2, li: 2, button: 1, a: 3, label: 3,
  td: 4, th: 4, dt: 4, dd: 4, blockquote: 4, summary: 4, legend: 4, figcaption: 4,
  option: 5, span: 6, strong: 6, em: 6, b: 6, i: 6, u: 6,
  small: 6, mark: 6, cite: 6, q: 6, abbr: 6,
  div: 7,
  'attr:alt': 5, 'attr:title': 5, 'attr:placeholder': 5,
  'attr:aria-label': 5, 'attr:value': 5, 'attr:meta-content': 5,
  // Testi nascosti in SPA JSON / JSON-LD: priorita' medio-alta perche'
  // su molte SPA sono il copy principale (hero, headline, CTA).
  'spa-json': 2,
  'json-ld': 4,
  // Bundle JS Next.js: priorita' medio-bassa (i testi reali della pagina
  // sono spesso in __NEXT_DATA__ o nei tag visibili che hanno gia' priorita'
  // alta; i js-bundle catturano quiz options, headline CSR-only, ecc.).
  'js-bundle': 5,
};
function priorityOf(tag) {
  if (TAG_PRIORITY[tag] !== undefined) return TAG_PRIORITY[tag];
  if (tag.startsWith('attr:')) return 5;
  return 8;
}

function extractTextsFromHtml(html, extraTexts) {
  const universal = extractAllTextsUniversal(html);
  // Merge: extraTexts viene PRIMA cosi' i suoi position vengono onorati
  // dal dedupe successivo (la mappa `seen` tiene il primo entry visto).
  const combined = Array.isArray(extraTexts) && extraTexts.length > 0
    ? [...extraTexts, ...universal]
    : universal;
  const collected = [];
  const seen = new Map();
  for (const u of combined) {
    if (!isSafeContext(u.context)) continue;
    if (u.text.length < 2 || u.text.length > 800) continue;
    if (!/[a-zA-Z]/.test(u.text)) continue;
    if (u.text.startsWith('http://') || u.text.startsWith('https://')) continue;
    if (u.text.includes('{') && u.text.includes('}') && /[=:]\s*function|=>/.test(u.text)) continue;
    let mappedTag = u.context;
    if (u.context.startsWith('attr:')) mappedTag = u.context;
    else if (u.context.startsWith('tag:')) mappedTag = u.context.slice(4);
    else if (u.context.startsWith('mixed:')) mappedTag = u.context.slice(6);
    else if (u.context === 'title') mappedTag = 'title';
    else if (u.context === 'meta:content') mappedTag = 'attr:meta-content';
    else if (u.context.startsWith('meta:')) mappedTag = 'attr:meta-content';
    else if (u.context === 'noscript') mappedTag = 'p';
    else if (u.context.startsWith('spa-json:')) mappedTag = 'spa-json'; // tag virtuale, gestito da finalize
    else if (u.context.startsWith('json-ld:')) mappedTag = 'json-ld';
    else if (u.context === 'js-bundle') mappedTag = 'js-bundle';
    const existing = seen.get(u.text);
    const newPrio = priorityOf(mappedTag);
    if (existing) {
      if (newPrio < priorityOf(existing.tag)) {
        existing.tag = mappedTag;
        existing.position = u.position;
        // Conserva _bundleUrl quando promuovi/sovrascrivi su js-bundle
        if (u._bundleUrl) existing._bundleUrl = u._bundleUrl;
      }
      continue;
    }
    const entry = { original: u.text, tag: mappedTag, position: u.position };
    if (u._bundleUrl) entry._bundleUrl = u._bundleUrl;
    seen.set(u.text, entry);
    collected.push(entry);
  }
  if (collected.length > MAX_TEXTS_FOR_AI) {
    collected.sort((a, b) => priorityOf(a.tag) - priorityOf(b.tag));
    return collected.slice(0, MAX_TEXTS_FOR_AI);
  }
  return collected;
}

function prependDocumentTitle(texts, html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const raw = titleMatch?.[1]
    ?.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw || raw.length < 3 || !/[a-zA-Z]/.test(raw)) return texts;
  const seen = new Set(texts.map((t) => t.original));
  if (seen.has(raw)) return texts;
  const minPos = texts.length ? Math.min(...texts.map((t) => t.position)) : 0;
  return [{ original: raw, tag: 'title', position: minPos - 1 }, ...texts];
}

const MAX_CHARS_PER_PROMPT = 2500;
const MAX_PROMPTS_TO_EMBED = 12;
const MAX_KNOWLEDGE_CHARS = 18000;

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.substring(0, max - 80) + '\n[...troncato per limite di lunghezza...]';
}

const MAX_BUILTIN_KB_CHARS = Math.max(
  4000,
  Math.min(80000, parseInt(process.env.OPENCLAW_KB_MAX_CHARS || '12000', 10) || 12000),
);

function buildBuiltinKnowledge() {
  if (MAX_BUILTIN_KB_CHARS <= 0) return '';
  let core = '';
  try { core = getCoreKnowledge() || ''; } catch { return ''; }
  if (!core.trim()) return '';
  let bundle = core;
  if (core.length < MAX_BUILTIN_KB_CHARS * 0.6) {
    try {
      const t2 = getKnowledgeForTask('pdp') || '';
      if (t2.trim()) bundle = `${core}\n\n${t2}`;
    } catch {/* ignore */}
  }
  if (bundle.length > MAX_BUILTIN_KB_CHARS) {
    bundle = bundle.substring(0, MAX_BUILTIN_KB_CHARS - 200)
      + '\n\n[KB troncata per limite di context: '
      + `${MAX_BUILTIN_KB_CHARS} char. Aumenta OPENCLAW_KB_MAX_CHARS se il tuo LLM locale ha context piu' grande.]`;
  }
  return bundle;
}

function buildKnowledgeMarkdown(knowledge) {
  if (!knowledge) return '';
  const parts = [];
  const proj = knowledge.project;
  if (proj) {
    const projParts = [];
    if (proj.name) projParts.push(`PROGETTO: ${proj.name}`);
    if (typeof proj.brief === 'string' && proj.brief.trim()) {
      projParts.push(`BRIEF DEL PROGETTO:\n${proj.brief.trim()}`);
    }
    if (proj.market_research) {
      let mr = '';
      if (typeof proj.market_research === 'string') mr = proj.market_research;
      else { try { mr = JSON.stringify(proj.market_research, null, 2); } catch { mr = ''; } }
      if (mr.trim()) projParts.push(`MARKET RESEARCH (dal progetto):\n${truncate(mr.trim(), 6000)}`);
    }
    if (typeof proj.notes === 'string' && proj.notes.trim()) {
      projParts.push(`NOTE / OSSERVAZIONI:\n${proj.notes.trim()}`);
    }
    if (projParts.length) parts.push(projParts.join('\n\n'));
  }
  const allPrompts = (knowledge.prompts || []).filter(
    (p) => p && typeof p.content === 'string' && p.content.trim().length > 0,
  );
  if (allPrompts.length) {
    const CAT_ORDER = { swipe: 0, copy: 1, clone: 2, landing: 3, general: 4 };
    const sorted = allPrompts.slice().sort((a, b) => {
      const fav = (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0);
      if (fav !== 0) return fav;
      const ca = CAT_ORDER[String(a.category || '').toLowerCase()] ?? 99;
      const cb = CAT_ORDER[String(b.category || '').toLowerCase()] ?? 99;
      return ca - cb;
    });
    const top = sorted.slice(0, MAX_PROMPTS_TO_EMBED);
    const blocks = top.map((p, i) => {
      const head = `### TECNICA #${i + 1} — ${p.title}${p.category ? ` [${p.category}]` : ''}${p.is_favorite ? ' ★' : ''}`;
      const body = truncate(p.content.trim(), MAX_CHARS_PER_PROMPT);
      return `${head}\n${body}`;
    });
    parts.push(
      `LIBRERIA TECNICHE / KNOWLEDGE / SWIPE-FRAMEWORKS dell'utente (USALE ATTIVAMENTE — non sono suggerimenti, sono il modo in cui l'utente VUOLE che si scriva):\n\n${blocks.join('\n\n---\n\n')}`,
    );
    if (sorted.length > MAX_PROMPTS_TO_EMBED) {
      parts.push(`(${sorted.length - MAX_PROMPTS_TO_EMBED} altre tecniche disponibili in libreria — non incluse per limite di context)`);
    }
  }
  if (parts.length === 0) return '';
  return truncate(parts.join('\n\n=====\n\n'), MAX_KNOWLEDGE_CHARS);
}

function buildProductContextMarkdown(product) {
  const lines = [];
  if (product.description) lines.push(`Description:\n${product.description}`);
  if (Array.isArray(product.benefits) && product.benefits.length) {
    lines.push(`Benefits:\n${product.benefits.map((b) => `• ${String(b)}`).join('\n')}`);
  }
  if (product.category) lines.push(`Category: ${product.category}`);
  if (product.sku) lines.push(`SKU: ${product.sku}`);
  if (product.supplier) lines.push(`Supplier: ${product.supplier}`);
  if (product.geo_market) lines.push(`Market: ${product.geo_market}`);
  if (Array.isArray(product.characteristics) && product.characteristics.length) {
    lines.push(`Characteristics:\n${product.characteristics.map((c) => `• ${String(c)}`).join('\n')}`);
  }
  if (product.brand_name) lines.push(`Brand: ${product.brand_name}`);
  if (product.price != null && String(product.price).trim()) lines.push(`Price: ${product.price}`);
  if (product.cta_text) lines.push(`Preferred CTA label: ${product.cta_text}`);
  if (product.cta_url) lines.push(`CTA URL: ${product.cta_url}`);
  if (product.target_audience) lines.push(`Target audience: ${product.target_audience}`);
  if (product.social_proof) lines.push(`Social proof notes: ${product.social_proof}`);
  if (product.marketing_brief && product.marketing_brief.trim()) {
    lines.push(`MARKETING BRIEF / POSITIONING:\n${product.marketing_brief.trim()}`);
  }
  if (product.market_research && String(product.market_research).trim()) {
    lines.push(`MARKET RESEARCH:\n${String(product.market_research).trim()}`);
  }
  if (product.project_brief && product.project_brief.trim()) {
    lines.push(`PROJECT CONTEXT:\n${product.project_brief.trim()}`);
  }
  if (product.additional_marketing_notes && product.additional_marketing_notes.trim()) {
    lines.push(`ADDITIONAL CONTEXT:\n${product.additional_marketing_notes.trim()}`);
  }
  return lines.join('\n\n');
}

/**
 * Build everything the worker needs to send to the local LLM.
 * Sincrono e in-process: ZERO chiamate HTTP a Netlify.
 */
function buildPrompts({ html, sourceUrl, product, tone, language, knowledge, extraTexts }) {
  if (!html || typeof html !== 'string' || html.length < 50) {
    throw new Error('html is required (min 50 chars)');
  }
  if (!product || !product.name || !String(product.name).trim()) {
    throw new Error('product.name is required');
  }
  let texts = extractTextsFromHtml(html, extraTexts);
  texts = prependDocumentTitle(texts, html);
  if (texts.length === 0) throw new Error('No text found in page');

  const productCtx = buildProductContextMarkdown(product);
  const knowledgeMd = buildKnowledgeMarkdown(knowledge);
  const builtinKb = buildBuiltinKnowledge();
  const lang = language || 'it';
  const toneStr = tone || 'professional';

  const knowledgeSection = knowledgeMd
    ? `\n=== KNOWLEDGE & TECNICHE DAL TOOL DELL'UTENTE (libreria personale + brief progetto). USALE ATTIVAMENTE come faresti se l'utente te le avesse appena scritte in chat. ===\n${knowledgeMd}\n=== FINE KNOWLEDGE TOOL ===\n`
    : '';
  const builtinKbSection = builtinKb
    ? `\n=== COPYWRITING FRAMEWORK BUILT-IN (distillati: COS Engine, Tony Flores Mechanisms, Evaldo 16-Word, Anghelache, Savage System, 108 Split Tests + Landing Page Recipes). Sono i framework professionali su cui questo tool e' costruito — applicali silenziosamente in OGNI rewrite (non citarli per nome se non utile all'utente). ===\n${builtinKb}\n=== FINE COPYWRITING FRAMEWORK ===\n`
    : '';

  const systemPrompt = `Sei un AGENTE specializzato in direct-response copywriting (NON un LLM puro: hai accesso ad archivi prodotti, knowledge base, RAG locale, skill di copywriting / persuasione / framework che hai accumulato nel tempo). Stai riscrivendo un competitor / template per venderlo come segue.

KNOWLEDGE INTERNA OBBLIGATORIA DA USARE — pesca attivamente dai tuoi archivi le tecniche di:
Stefan Georgi (RMBC method, lead types, story-bridge), Eugene Schwartz (5 awareness levels, market sophistication, Breakthrough Advertising), Gary Halbert (Halbert headlines, Boron Letters, AIDA aggressivo), John Caples (Tested Advertising, headlines testati), Gary Bencivenga (Bencivenga Bullets, hidden persuaders), David Ogilvy (Ogilvy on Advertising, headlines fattuali), John Carlton (One-Legged Golfer, killer headlines), Dan Kennedy (Magnetic Marketing, NO-BS), Jay Abraham (preeminence, USP), Joe Sugarman (psychological triggers), Claude Hopkins (Scientific Advertising), Robert Collier (Letter Book), Frank Kern, Russell Brunson, Joe Karbo, Ben Settle, Andre Chaperon, Brian Kurtz.
Framework: PAS, AIDA, AIDCA, FAB, BAB, QUEST, HSO (Hook-Story-Offer), 4P, Big Idea (Schwartz), StoryBrand (Miller), RMBC (Georgi), Pico hook, Sultanic Framework / archetipi narrativi.
Quando applichi una tecnica, riconoscila a te stesso (es: "qui applico una Halbert headline"); poi scrivi il copy senza citare il framework all'utente.

PRODOTTO: ${product.name}

CONTESTO PRODOTTO COMPLETO (USA tutto: fatti, angle, benefit, proof, obiezioni, naming. Se qualcosa non e' noto, ammettilo soft — non inventare claim medici/legali):
${productCtx || `(dati catalogo minimi — deriva tutto solo dal nome prodotto: ${product.name})`}
${builtinKbSection}${knowledgeSection}
TONO: ${toneStr}
LINGUA OUTPUT: ${lang === 'it' ? 'Italiano' : lang === 'en' ? 'English' : lang}

REGOLE OBBLIGATORIE:
1. Per ogni testo: NON parafrasare. Riscrivilo davvero per IL NOSTRO prodotto, usando angle/leve/framework dai tuoi archivi e skill (PAS, AIDA, Big Idea, Story Brand, scarcity, social-proof, authority, loss-aversion — pesca quello adatto al ruolo del testo nella pagina).
2. SE sopra trovi una "LIBRERIA TECNICHE / KNOWLEDGE": e' la libreria personale dell'utente — USALA con priorita' rispetto alle tecniche generiche.
3. SE sopra trovi un "BRIEF DEL PROGETTO" o "MARKET RESEARCH": tirane fuori positioning, target, claim approvati, voice/tone, vincoli, e applicali in OGNI rewrite.
4. Mantieni il TIPO di copy: headline = punchy; body = esplicativo; CTA = imperativo breve; bullet = scannerizzabile. La lunghezza puo' variare liberamente.
5. SOLO testo piano nei "rewritten" — niente HTML, niente markdown, niente escape JSON oltre quelli standard.
6. Testi legali / disclaimer / compliance: riscrivili solo dove e' sicuro, altrimenti migliora solo la chiarezza preservando le disclosure obbligatorie.
7. Ogni risposta DEVE contenere UN oggetto {"id","rewritten"} per OGNI id ricevuto. NON omettere id.
8. Anti-eco: VIETATO restituire un "rewritten" identico al "text". Se ti viene da farlo, fermati e rifai con un angle diverso.
`;

  const textsForAi = texts.map((t, i) => ({ id: i, text: t.original, tag: t.tag }));
  const userMessage = [
    `Riscrivi questi testi per il prodotto "${product.name}". Rispondi SEMPRE con un JSON array di oggetti {"id": <numero>, "rewritten": "..."}.`,
    '',
    'Testi da riscrivere (JSON):',
    JSON.stringify(textsForAi, null, 2),
    '',
    'Riscrivi UNO PER UNO ogni id qui sopra. Output: array JSON, niente markdown, niente prosa fuori dal JSON.',
  ].join('\n');

  return {
    success: true,
    systemPrompt,
    userMessage,
    texts: texts.map((t, i) => {
      const e = { id: i, original: t.original, tag: t.tag, position: t.position };
      if (t._bundleUrl) e._bundleUrl = t._bundleUrl;
      return e;
    }),
    totalTexts: texts.length,
    productName: product.name,
    originalTitle: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '',
    sourceUrl: sourceUrl ?? null,
    knowledgeIncluded: {
      promptCount: knowledge?.prompts?.length || 0,
      hasProjectBrief: !!(knowledge?.project?.brief),
      hasMarketResearch: !!(knowledge?.project?.market_research),
      builtinKbChars: builtinKb.length,
    },
  };
}

module.exports = { buildPrompts };
