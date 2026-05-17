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
// Cap globale della knowledge section (brief progetto + MR + libreria tecniche).
// Alzato da 18k a 35k: a 18k il brief lungo + MR + 12 prompt venivano troncati
// a meta', con la conseguenza che facts specifici (nome dottore, durata audio,
// prezzi, garanzia) descritti in fondo al brief NON arrivavano al LLM e i
// rewrite mantenevano i facts del competitor. 35k e' ancora sicuro per LLM
// locali con context >= 16k token (il system prompt totale resta < 60k char).
const MAX_KNOWLEDGE_CHARS = 35000;
// Cap per la MR (porzione dentro la knowledge section). Alzato da 6k a 12k:
// stessa logica del cap globale, i facts della MR (audience age/income,
// pain-point esatti, claim approvati) sono spesso oltre i primi 6k char.
const MAX_MR_CHARS = 12000;

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
      if (mr.trim()) projParts.push(`MARKET RESEARCH (dal progetto):\n${truncate(mr.trim(), MAX_MR_CHARS)}`);
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

// Estrae facts CONCRETI dal product + (best-effort) dal brief/MR per
// costruire una cheat-sheet che il LLM puo' usare per FACT-SUBSTITUTION
// quando incontra fatti del competitor nei testi originali.
//
// Conservative-by-default: meglio una cheat-sheet piu' corta ma giusta
// che una lunga ma con falsi positivi (il LLM userebbe i falsi positivi).
//
// Categorie di facts:
//   - nome prodotto + brand
//   - prezzo (full + scontato se presenti nel brief)
//   - dottori / esperti / autorita' (regex su brief: "Dr.", "Dott.", "Prof.")
//   - durate (regex: "X min[uti|utes|']", "X giorni|days|day")
//   - garanzie (regex: "X-day money back|guarantee|garanzia")
//   - ingredienti chiave (da product.characteristics se lista)
function extractProductFacts(product, knowledge) {
  const facts = {
    name: '',
    brand: '',
    price: '',
    doctors: [],
    durations: [],
    guarantees: [],
    percentages: [],
    ingredients: [],
    targetAge: '',
  };
  if (product) {
    if (product.name) facts.name = String(product.name).trim();
    if (product.brand_name) facts.brand = String(product.brand_name).trim();
    if (product.price != null && String(product.price).trim()) facts.price = String(product.price).trim();
    if (Array.isArray(product.characteristics)) {
      // characteristics sono spesso ingredienti / specs (es. "200mg Magnesium",
      // "9-minute audio session"). Le mettiamo come "ingredienti" lato facts.
      facts.ingredients = product.characteristics
        .map((c) => String(c || '').trim())
        .filter((c) => c.length > 0 && c.length < 120);
    }
  }
  // Pesca dal brief e da MR — sempre meglio di niente. Conservative regex.
  const sources = [];
  if (knowledge?.project?.brief && typeof knowledge.project.brief === 'string') {
    sources.push(knowledge.project.brief);
  }
  if (knowledge?.project?.market_research) {
    const mr = knowledge.project.market_research;
    if (typeof mr === 'string') sources.push(mr);
    else { try { sources.push(JSON.stringify(mr)); } catch {/* skip */} }
  }
  if (product?.description) sources.push(String(product.description));
  if (product?.marketing_brief) sources.push(String(product.marketing_brief));
  if (product?.project_brief) sources.push(String(product.project_brief));
  if (product?.market_research) sources.push(String(product.market_research));
  const corpus = sources.join('\n\n');
  if (corpus) {
    // Dottori / esperti — match conservativo: titolo + 1-3 token capitalizzati
    const docRe = /\b(?:Dr|Dott|Dr\.ssa|Dott\.ssa|Prof|Professor|Doctor|Doctora)\.?\s+([A-Z][a-zA-Zàèéìòù'-]+(?:\s+[A-Z][a-zA-Zàèéìòù'-]+){0,2})/g;
    const docSeen = new Set();
    let dm;
    while ((dm = docRe.exec(corpus)) !== null) {
      const name = `${dm[0]}`.replace(/\s+/g, ' ').trim();
      if (!docSeen.has(name) && docSeen.size < 5) { docSeen.add(name); facts.doctors.push(name); }
    }
    // Durate audio/sessione/protocollo (minuti, secondi, ore)
    const durRe = /\b(\d{1,4})\s*[-\s]?\s*(min(?:uti|utes|ute|s|s\.)?|sec(?:ondi|onds|ond|s)?|h(?:ours|our|rs|r)?|ore|hour)\b/gi;
    const durSeen = new Set();
    let durm;
    while ((durm = durRe.exec(corpus)) !== null) {
      const val = `${durm[1]} ${durm[2].toLowerCase()}`.trim();
      if (!durSeen.has(val) && durSeen.size < 8) { durSeen.add(val); facts.durations.push(val); }
    }
    // Garanzie "X-day money back" / "garanzia X giorni"
    const guarRe = /\b(\d{1,3})[-\s]?(day|days|giorni|giorno)\s+(money[-\s]?back|garanzia|guarantee|refund|rimborso)\b/gi;
    const guarSeen = new Set();
    let gm;
    while ((gm = guarRe.exec(corpus)) !== null) {
      const val = gm[0].replace(/\s+/g, ' ').trim();
      if (!guarSeen.has(val) && guarSeen.size < 3) { guarSeen.add(val); facts.guarantees.push(val); }
    }
    // Percentuali "X%" (no \b dopo % perche' % non e' word-char,
    // \b fallirebbe sul confine non-word/non-word).
    const pctRe = /\b(\d{1,3}(?:[.,]\d+)?)\s*%/g;
    const pctSeen = new Set();
    let pm;
    while ((pm = pctRe.exec(corpus)) !== null) {
      if (!pctSeen.has(pm[1]) && pctSeen.size < 6) { pctSeen.add(pm[1]); facts.percentages.push(`${pm[1]}%`); }
    }
    // Target age "X-Y year" / "X to Y year" / "tra X e Y anni" / "X-Y anni"
    const ageRe = /\b(\d{2,3})\s*(?:[-–]|to|a)\s*(\d{2,3})\s*(years?|year[-\s]?old|anni|year)\b/i;
    const am = corpus.match(ageRe);
    if (am) facts.targetAge = am[0].trim();
  }
  return facts;
}

function buildProductFactsBlock(facts) {
  const lines = [];
  if (facts.name) lines.push(`• Nome prodotto: ${facts.name}`);
  if (facts.brand) lines.push(`• Brand: ${facts.brand}`);
  if (facts.price) lines.push(`• Prezzo: ${facts.price}`);
  if (facts.doctors.length) lines.push(`• Dottori / esperti / autorita': ${facts.doctors.join(' · ')}`);
  if (facts.durations.length) lines.push(`• Durate ricorrenti (es. audio, sessioni, protocollo): ${facts.durations.join(' · ')}`);
  if (facts.guarantees.length) lines.push(`• Garanzia: ${facts.guarantees.join(' · ')}`);
  if (facts.percentages.length) lines.push(`• Percentuali chiave: ${facts.percentages.join(' · ')}`);
  if (facts.targetAge) lines.push(`• Eta' target: ${facts.targetAge}`);
  if (facts.ingredients.length) {
    const ing = facts.ingredients.slice(0, 12);
    lines.push(`• Ingredienti / specs (top ${ing.length}): ${ing.join(' · ')}`);
  }
  if (!lines.length) return '';
  return lines.join('\n');
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
  const productFacts = extractProductFacts(product, knowledge);
  const productFactsBlock = buildProductFactsBlock(productFacts);
  const lang = language || 'it';
  const toneStr = tone || 'professional';

  // PRODUCT FACTS sheet: dati concreti (nome, prezzo, dottori, durate,
  // garanzia, ingredienti) estratti dal product + brief + MR. Va in cima
  // al prompt cosi' il LLM li ha sempre presenti per fact-substitution.
  const productFactsSection = productFactsBlock
    ? `\n=== PRODUCT FACTS — FATTI CONCRETI DEL NOSTRO PRODOTTO (cheat sheet auto-estratta). Quando un testo del competitor menziona un fatto equivalente, SOSTITUISCILO con il fatto qui sotto. ===\n${productFactsBlock}\n=== FINE PRODUCT FACTS ===\n`
    : '';

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
${productFactsSection}
CONTESTO PRODOTTO COMPLETO (USA tutto: fatti, angle, benefit, proof, obiezioni, naming. Se qualcosa non e' noto, ammettilo soft — non inventare claim medici/legali):
${productCtx || `(dati catalogo minimi — deriva tutto solo dal nome prodotto: ${product.name})`}
${builtinKbSection}${knowledgeSection}
TONO: ${toneStr}
LINGUA OUTPUT: ${lang === 'it' ? 'Italiano' : lang === 'en' ? 'English' : lang}

REGOLE OBBLIGATORIE:
1. Per ogni testo: NON parafrasare. Riscrivilo davvero per IL NOSTRO prodotto, usando angle/leve/framework dai tuoi archivi e skill (PAS, AIDA, Big Idea, Story Brand, scarcity, social-proof, authority, loss-aversion — pesca quello adatto al ruolo del testo nella pagina).
2. SE sopra trovi una "LIBRERIA TECNICHE / KNOWLEDGE": e' la libreria personale dell'utente — USALA con priorita' rispetto alle tecniche generiche.
3. SE sopra trovi un "BRIEF DEL PROGETTO" o "MARKET RESEARCH": tirane fuori positioning, target, claim approvati, voice/tone, vincoli, e applicali in OGNI rewrite.
4. ⚠️ FACT SUBSTITUTION OBBLIGATORIA (la piu' importante — non saltarla mai):
   Se il testo originale contiene un FATTO SPECIFICO (nome di una persona, numero, durata, prezzo, ingrediente, percentuale, anno, garanzia, eta', citta'), controlla la sezione "PRODUCT FACTS" e il BRIEF del progetto qui sopra:
   - se trovi il fatto EQUIVALENTE del nostro prodotto → SOSTITUISCI quello del competitor con il nostro (es. "Dr. Sarah Johnson" del competitor → "Dr. Marco Rossi" del nostro brief; "15 minutes" del competitor → "9 minutes" del nostro brief; "$97" → "$67")
   - se NON hai l'equivalente → usa un termine neutro generico (es. "il nostro esperto" / "the formula" / "la sessione" / "la garanzia"), MAI lasciare il fatto del competitor
   - VIETATO inventare numeri, dosaggi, claim medici o nomi propri che non sono nel brief / product facts
   Esempi di violazioni che mi devo vietare:
     ✗ originale "Dr. Sarah Johnson said" → rewrite "Dr. Sarah Johnson said" (lasciato il competitor)
     ✗ originale "15-minute audio" → rewrite "15-minute audio" (lasciata la durata del competitor)
     ✓ originale "Dr. Sarah Johnson said" + brief con "Dr. Marco Rossi" → rewrite "Dr. Marco Rossi dice"
     ✓ originale "15-minute audio" + brief con "9 minuti" → rewrite "9-minute audio"
     ✓ originale "Dr. Sarah Johnson" + NESSUN dottore nel brief → rewrite "il nostro esperto"
5. Mantieni il TIPO di copy: headline = punchy; body = esplicativo; CTA = imperativo breve; bullet = scannerizzabile. La lunghezza puo' variare liberamente.
6. SOLO testo piano nei "rewritten" — niente HTML, niente markdown, niente escape JSON oltre quelli standard.
7. Testi legali / disclaimer / compliance: riscrivili solo dove e' sicuro, altrimenti migliora solo la chiarezza preservando le disclosure obbligatorie.
8. Ogni risposta DEVE contenere UN oggetto {"id","rewritten"} per OGNI id ricevuto. NON omettere id.
9. Anti-eco: VIETATO restituire un "rewritten" identico al "text". Se ti viene da farlo, fermati e rifai con un angle diverso.
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
      projectBriefChars: knowledge?.project?.brief ? String(knowledge.project.brief).length : 0,
      marketResearchChars: (() => {
        const mr = knowledge?.project?.market_research;
        if (!mr) return 0;
        if (typeof mr === 'string') return mr.length;
        try { return JSON.stringify(mr).length; } catch { return 0; }
      })(),
    },
    productFacts: {
      doctors: productFacts.doctors,
      durations: productFacts.durations,
      guarantees: productFacts.guarantees,
      percentages: productFacts.percentages,
      ingredientsCount: productFacts.ingredients.length,
      hasName: !!productFacts.name,
      hasPrice: !!productFacts.price,
      sheetChars: productFactsBlock.length,
    },
  };
}

module.exports = { buildPrompts };
