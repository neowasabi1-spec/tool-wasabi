import { NextRequest, NextResponse } from 'next/server';
import {
  createAffiliateSavedFunnel,
  fetchAffiliateBrowserChatByJobId,
} from '@/lib/supabase-operations';

// =====================================================
// Claude prompt for structuring the agent result
// =====================================================

const STRUCTURING_PROMPT = `You are an expert in marketing and sales funnels. You are given the textual result of a browser agent that has navigated and analyzed an online funnel (quiz funnel, sales funnel, landing page, etc.).

Your task is to EXTRACT and STRUCTURE all information into a precise JSON object.

CRITICAL OUTPUT RULE: Your response MUST start DIRECTLY with the character { and end with }. DO NOT add ANYTHING before or after the JSON — no text, no explanation, no markdown, no code blocks. ONLY the pure JSON object.

The JSON object must have EXACTLY these keys:

{
  "funnel_name": "Descriptive name of the funnel (e.g.: 'Bioma Health Weight Loss Quiz Funnel')",
  "brand_name": "Brand/company name (e.g.: 'Bioma Health') or null if not identifiable",
  "entry_url": "URL of the first page of the funnel",
  "funnel_type": "ONE of: quiz_funnel | sales_funnel | landing_page | webinar_funnel | tripwire_funnel | lead_magnet | vsl_funnel | other",
  "category": "ONE of: weight_loss | supplements | skincare | fitness | finance | saas | ecommerce | health | education | dating | real_estate | crypto | spirituality | astrology | other",
  "tags": ["array", "of", "relevant", "tags"],
  "total_steps": 19,
  "steps": [
    {
      "step_index": 1,
      "url": "https://example.com/step1",
      "title": "Step title or question",
      "step_type": "ONE of: quiz_question | info_screen | lead_capture | checkout | upsell | downsell | thank_you | landing | product_page | processing | other",
      "input_type": "ONE of: multiple_choice | checkbox | text_input | numeric_input | image_select | email_input | button | slider | date_picker | none",
      "options": ["Option 1", "Option 2"],
      "description": "Brief description of visible elements on the page",
      "cta_text": "Main button/CTA text or null"
    }
  ],
  "analysis_summary": "Funnel analysis paragraph (2-4 sentences).",
  "persuasion_techniques": ["scarcity", "social_proof", "authority", "progress_bar", "personalization"],
  "lead_capture_method": "ONE of: email | phone | form | social_login | none",
  "notable_elements": ["element 1", "element 2"]
}

IMPORTANT RULES:
- Extract ALL steps mentioned in the text, even if they have different formats
- If information is not available, use null for strings and [] for arrays
- For funnel_type: if there are questions/quiz → quiz_funnel; if there is a sales page → sales_funnel; etc.
- For category: deduce from the content of questions and the product
- Tags must be specific and useful for filtering
- The analysis_summary must be a professional analysis
- Identify ALL persuasion techniques used
- The notable_elements are notable design/UX characteristics`;

// =====================================================
// JSON PARSING — Multi-strategy, impossible to fail
// =====================================================

function parseJsonFromResponse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  // Strategy 1: direct parse
  try {
    const direct = JSON.parse(trimmed) as Record<string, unknown>;
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  } catch { /* continue */ }

  // Strategy 2: extract from markdown code block
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try {
      return JSON.parse(codeBlock[1].trim()) as Record<string, unknown>;
    } catch { /* continue */ }
  }

  // Strategy 3: find outermost { ... }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const extracted = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(extracted) as Record<string, unknown>;
    } catch { /* continue */ }

    // Strategy 3b: clean common issues (trailing commas, comments)
    const cleaned = extracted
      .replace(/,\s*([\]}])/g, '$1')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    try {
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch { /* continue */ }
  }

  // Strategy 4: JSON truncated — repair by closing open brackets
  if (firstBrace !== -1) {
    let partial = trimmed.slice(firstBrace);
    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
    let escape = false;
    for (const ch of partial) {
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') openBraces++;
      if (ch === '}') openBraces--;
      if (ch === '[') openBrackets++;
      if (ch === ']') openBrackets--;
    }
    if (openBraces > 0 || openBrackets > 0) {
      // Remove incomplete trailing content
      partial = partial.replace(/,\s*"[^"]*"?\s*:?\s*"?[^",}\]]*$/, '');
      partial = partial.replace(/,\s*\{[^}]*$/, '');
      partial = partial.replace(/,\s*"[^"]*$/, '');
      partial = partial.replace(/,\s*$/, '');
      // Recount after trimming
      openBraces = 0; openBrackets = 0; inString = false; escape = false;
      for (const ch of partial) {
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++;
        if (ch === '}') openBraces--;
        if (ch === '[') openBrackets++;
        if (ch === ']') openBrackets--;
      }
      for (let i = 0; i < openBrackets; i++) partial += ']';
      for (let i = 0; i < openBraces; i++) partial += '}';
      partial = partial.replace(/,\s*([\]}])/g, '$1');
      try {
        const repaired = JSON.parse(partial) as Record<string, unknown>;
        if (repaired && typeof repaired === 'object') {
          console.warn('[save-funnel] JSON truncated → repaired successfully');
          return repaired;
        }
      } catch { /* continue */ }
    }
  }

  return null;
}

// =====================================================
// FALLBACK PARSER — Extracts data directly from text
// without needing Claude. Handles ANY format.
// =====================================================

interface ExtractedStep {
  step_index: number;
  url: string | null;
  title: string | null;
  step_type: string;
  input_type: string;
  options: string[];
  description: string | null;
  cta_text: string | null;
}

function regexFallbackParse(text: string, saveType?: 'quiz' | 'funnel'): Record<string, unknown> {
  console.warn('[save-funnel] Using regex fallback parser on raw agent text');

  const steps: ExtractedStep[] = [];
  const allUrls: string[] = [];

  // ─── Extract all URLs ───
  const urlMatches = text.match(/https?:\/\/[^\s,)"'>\]]+/g) || [];
  for (const u of urlMatches) {
    const clean = u.replace(/[.,:;!?)]+$/, '');
    if (!allUrls.includes(clean)) allUrls.push(clean);
  }

  // ─── Pattern A: "### STEP N" blocks (most common agent format) ───
  const stepBlocksA = text.split(/(?=###\s*STEP\s*\d+)/i);
  for (const block of stepBlocksA) {
    const headerMatch = block.match(/###\s*STEP\s*(\d+)/i);
    if (!headerMatch) continue;
    const idx = parseInt(headerMatch[1], 10);

    const url = extractField(block, [
      /\*?\s*URL\s*(?:ESATTO|esatto)?\s*:\s*(.+)/i,
      /URL\s*:\s*(https?:\/\/[^\s]+)/i,
    ]);
    const title = extractField(block, [
      /\*?\s*DOMANDA\s*\/?\s*TITOLO\s*:\s*(.+)/i,
      /\*?\s*TITOLO\s*:\s*(.+)/i,
      /\*?\s*DOMANDA\s*:\s*(.+)/i,
    ]);
    const inputTypeRaw = extractField(block, [
      /\*?\s*TIPO\s*DI\s*INPUT\s*:\s*(.+)/i,
      /\*?\s*INPUT\s*TYPE\s*:\s*(.+)/i,
    ]);
    const optionsRaw = extractField(block, [
      /\*?\s*OPZIONI\s*(?:DISPONIBILI)?\s*:\s*(.+)/i,
      /\*?\s*OPTIONS?\s*:\s*(.+)/i,
    ]);
    const description = extractField(block, [
      /\*?\s*ELEMENTI\s*VISIVI\s*:\s*(.+)/i,
      /\*?\s*DESCRIPTION\s*:\s*(.+)/i,
    ]);
    const ctaText = extractField(block, [
      /\*?\s*AZIONE\s*COMPIUTA\s*:\s*(.+)/i,
      /\*?\s*CTA\s*:\s*(.+)/i,
    ]);

    const options = optionsRaw
      ? optionsRaw.split(/[,;]|(?:"\s*,\s*")|(?:,\s+)/).map(o => o.replace(/^["'\s]+|["'\s]+$/g, '').trim()).filter(Boolean)
      : [];

    steps.push({
      step_index: idx,
      url: url?.trim() || null,
      title: title?.trim() || null,
      step_type: inferStepType(title, inputTypeRaw, options, url),
      input_type: inferInputType(inputTypeRaw, options),
      options,
      description: description?.trim() || null,
      cta_text: ctaText?.trim() || null,
    });
  }

  // ─── Pattern B: "--- STEP N ---" blocks ───
  if (steps.length === 0) {
    const stepBlocksB = text.split(/(?=---\s*STEP\s*\d+)/i);
    for (const block of stepBlocksB) {
      const headerMatch = block.match(/---\s*STEP\s*(\d+)/i);
      if (!headerMatch) continue;
      const idx = parseInt(headerMatch[1], 10);

      const url = extractField(block, [/URL\s*:\s*(https?:\/\/[^\s]+)/i]);
      const title = extractField(block, [
        /Titolo\s*:\s*(.+)/i,
        /Title\s*:\s*(.+)/i,
        /Domanda\s*:\s*(.+)/i,
        /Question\s*:\s*(.+)/i,
      ]);
      const optionsRaw = extractField(block, [
        /Opzioni(?:\s*di\s*risposta)?\s*:\s*([\s\S]*?)(?=\n\s*(?:URL|Titolo|Title|---|\*|CTA|Tipo|$))/i,
      ]);
      const options = optionsRaw
        ? optionsRaw.split(/\n/).map(l => l.replace(/^\s*\d+\.\s*/, '').trim()).filter(Boolean)
        : [];

      steps.push({
        step_index: idx,
        url: url?.trim() || null,
        title: title?.trim() || null,
        step_type: inferStepType(title, null, options, url),
        input_type: inferInputType(null, options),
        options,
        description: null,
        cta_text: null,
      });
    }
  }

  // ─── Pattern C: numbered "Step N:" or "N." blocks ───
  if (steps.length === 0) {
    const stepRegex = /(?:^|\n)\s*(?:Step\s*)?(\d+)[.):\s]+\s*(.+?)(?=\n\s*(?:Step\s*)?\d+[.):\s]|\n\s*#{2,}|\n\s*---|\n\s*\*\*|$)/gi;
    let m: RegExpExecArray | null;
    while ((m = stepRegex.exec(text)) !== null) {
      const idx = parseInt(m[1], 10);
      const content = m[2]?.trim();
      if (!content || idx > 100) continue;

      const url = content.match(/(https?:\/\/[^\s,)"']+)/)?.[1] || null;
      steps.push({
        step_index: idx,
        url,
        title: content.replace(/(https?:\/\/[^\s]+)/g, '').trim().slice(0, 200) || null,
        step_type: 'other',
        input_type: 'none',
        options: [],
        description: null,
        cta_text: null,
      });
    }
  }

  // ─── Pattern D: URL-based step extraction (last resort — grab distinct URLs as steps) ───
  if (steps.length === 0 && allUrls.length > 0) {
    allUrls.forEach((url, i) => {
      steps.push({
        step_index: i + 1,
        url,
        title: url.split('/').pop()?.replace(/[-_]/g, ' ') || null,
        step_type: 'other',
        input_type: 'none',
        options: [],
        description: null,
        cta_text: null,
      });
    });
  }

  // ─── Extract metadata ───
  const entryUrl = steps[0]?.url || allUrls[0] || '';
  const domain = entryUrl ? extractDomain(entryUrl) : null;

  const funnelName = extractFunnelName(text, domain, steps);
  const brandName = extractBrandName(text, domain);
  const hasQuizSteps = steps.some(s =>
    s.step_type === 'quiz_question' || s.options.length >= 2
  );
  const funnelType = saveType === 'quiz' || hasQuizSteps ? 'quiz_funnel' : 'other';
  const category = inferCategory(text);

  // ─── Persuasion techniques detection ───
  const techniques: string[] = [];
  const techMap: Record<string, RegExp> = {
    progress_bar: /progress\s*bar|barra\s*(?:di\s*)?progresso|\d+\s*(?:\/|di)\s*\d+/i,
    social_proof: /social\s*proof|testimoni|reviews?|rated|accuracy|users?.*(?:trust|love|discovered)/i,
    scarcity: /timer|countdown|limited|scarcity|urgency|(?:solo|only)\s*\d+.*(?:left|rimast)/i,
    personalization: /personaliz|your\s*(?:result|reading)|tuo\s*risultato|customiz/i,
    authority: /expert|doctor|scientif|studi|research|(?:93|95|97|98|99)[\s.,]*%/i,
    commitment_consistency: /commitment|step\s*by\s*step|continua|continue|next/i,
    loss_aversion: /(?:don'?t|non)\s*(?:miss|perdere)|risk|losing|before\s*it'?s\s*too\s*late/i,
    reciprocity: /free|gratis|omaggio|bonus|gift/i,
  };
  for (const [name, regex] of Object.entries(techMap)) {
    if (regex.test(text)) techniques.push(name);
  }

  // ─── Lead capture detection ───
  let leadCapture = 'none';
  if (/email|e-mail|mail/i.test(text)) leadCapture = 'email';
  else if (/phone|telefono|sms/i.test(text)) leadCapture = 'phone';
  else if (/form|modulo|registra/i.test(text)) leadCapture = 'form';

  // ─── Notable elements ───
  const notable: string[] = [];
  if (steps.length > 20) notable.push(`Long funnel with ${steps.length} steps`);
  if (hasQuizSteps) notable.push('Interactive quiz with multiple choice questions');
  if (/palm|scan|body|mano|palmo/i.test(text)) notable.push('Palm scan / body mapping interattivo');
  if (/progress/i.test(text)) notable.push('Progress bar during quiz');
  if (/email/i.test(text)) notable.push('Email lead capture');
  if (/checkout|payment|pagamento|trial|prezzo|price|\$\d+/i.test(text)) notable.push('Checkout / payment in the funnel');
  if (/info.*screen|feedback.*intermedi|motivazion/i.test(text)) notable.push('Intermediate informational / motivational screens');
  const inputTypes = new Set(steps.map(s => s.input_type).filter(t => t !== 'none'));
  if (inputTypes.size >= 3) notable.push(`Mix of ${inputTypes.size} different input types`);

  // ─── Tags ───
  const tags: string[] = [];
  if (funnelType === 'quiz_funnel') tags.push('quiz');
  if (leadCapture === 'email') tags.push('email_capture');
  if (domain) tags.push(domain);
  const topicWords = extractTopicTags(text);
  tags.push(...topicWords);

  // ─── Analysis summary (basic auto-generated) ───
  const analysisSummary = `Funnel analyzed with ${steps.length} total steps${hasQuizSteps ? ', interactive quiz structure' : ''}. ` +
    `${techniques.length > 0 ? `Persuasion techniques identified: ${techniques.join(', ')}. ` : ''}` +
    `${leadCapture !== 'none' ? `Lead capture via ${leadCapture}. ` : ''}` +
    `${notable.length > 0 ? notable[0] + '.' : ''}`;

  return {
    funnel_name: funnelName,
    brand_name: brandName,
    entry_url: entryUrl,
    funnel_type: funnelType,
    category,
    tags: Array.from(new Set(tags)).slice(0, 15),
    total_steps: steps.length,
    steps,
    analysis_summary: analysisSummary,
    persuasion_techniques: techniques,
    lead_capture_method: leadCapture,
    notable_elements: notable,
  };
}

// ─── Regex helpers ───

function extractField(block: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = block.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function inferStepType(
  title: string | null,
  inputType: string | null,
  options: string[],
  url: string | null,
): string {
  const t = (title || '').toLowerCase();
  const u = (url || '').toLowerCase();
  const it = (inputType || '').toLowerCase();

  if (/email|e-mail|make\s*sure.*results/i.test(t) || /email/i.test(u)) return 'lead_capture';
  if (/checkout|payment|pay|trial.*price|get.*results|pagamento/i.test(t) || /checkout|payment|trial/i.test(u)) return 'checkout';
  if (/continue|your\s*goal\s*is\s*set|you\s*carry|awaken|reveal/i.test(t) && options.length === 0) return 'info_screen';
  if (/scan.*palm|palm.*scan/i.test(t)) return 'info_screen';
  if (it.includes('bottone') && options.length <= 1) return 'info_screen';
  if (options.length >= 2 || /scelta|choice|select/i.test(it)) return 'quiz_question';
  if (/date.*birth|data.*nascita|birthday/i.test(t)) return 'quiz_question';
  if (/landing|prelanding|pre-landing/i.test(u)) return 'landing';
  return 'other';
}

function inferInputType(inputTypeRaw: string | null, options: string[]): string {
  const it = (inputTypeRaw || '').toLowerCase();
  if (/scelta\s*multipla|multi.*choice|checkbox/i.test(it)) return options.length > 0 ? 'checkbox' : 'checkbox';
  if (/scelta\s*singola|single.*choice|radio/i.test(it)) return 'multiple_choice';
  if (/bottone|button|cta/i.test(it)) return 'button';
  if (/dropdown|select|data|date/i.test(it)) return 'date_picker';
  if (/slider/i.test(it)) return 'slider';
  if (/text|input.*testo/i.test(it)) return 'text_input';
  if (/email/i.test(it)) return 'email_input';
  if (/image|immagine|griglia|grid/i.test(it)) return 'image_select';
  if (options.length >= 2) return 'multiple_choice';
  return 'button';
}

function extractDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, '');
  } catch { return null; }
}

function extractFunnelName(text: string, domain: string | null, steps: ExtractedStep[]): string {
  // Try to find a title-like heading
  const headingMatch = text.match(/#{1,3}\s*(?:ANALISI|ANALYSIS|REPORT|FUNNEL)\s*[:\-]?\s*(.+)/i);
  if (headingMatch) return headingMatch[1].trim().slice(0, 100);

  // Try first step title
  const firstTitle = steps[0]?.title;
  if (firstTitle && firstTitle.length > 5) {
    return `${firstTitle.slice(0, 60)} Quiz Funnel`;
  }

  // Use domain
  if (domain) return `${domain} Funnel`;

  return 'Quiz Funnel (auto-saved)';
}

function extractBrandName(text: string, domain: string | null): string | null {
  const brandMatch = text.match(/brand\s*(?:name)?\s*:\s*(.+)/i);
  if (brandMatch) return brandMatch[1].trim().slice(0, 60);
  if (domain) {
    const name = domain.split('.')[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return null;
}

function inferCategory(text: string): string {
  const t = text.toLowerCase();
  const catMap: [string, RegExp][] = [
    ['spirituality', /starseed|spirit\s*animal|chakra|spiritual|divine|lightworker|soul|aura|meditation|cosmic|celestial/i],
    ['astrology', /astrol|zodiac|horoscope|birth\s*chart|natal|saturn|mercury|venus|mars|pluto/i],
    ['weight_loss', /weight\s*loss|dieta|dimagri|perdere\s*peso|gut\s*health|metabolism|slim/i],
    ['supplements', /supplement|integratore|probiot|vitamin|collagen|omega/i],
    ['skincare', /skincare|skin\s*care|beauty|anti[\s-]*aging|wrinkle|serum|moisturiz/i],
    ['fitness', /fitness|workout|exercise|palestra|gym|muscle|training/i],
    ['finance', /finance|trading|investment|invest|money|crypto|forex|stock/i],
    ['crypto', /crypto|bitcoin|blockchain|nft|defi|ethereum/i],
    ['saas', /saas|software|app|platform|tool|dashboard/i],
    ['ecommerce', /ecommerce|e-commerce|shop|store|product|buy|cart/i],
    ['health', /health|salute|medical|doctor|wellness|benessere/i],
    ['education', /course|corso|learn|education|training|webinar|class/i],
    ['dating', /dating|relationship|love|partner|match/i],
    ['real_estate', /real\s*estate|immobil|property|house|home/i],
  ];
  for (const [cat, regex] of catMap) {
    if (regex.test(t)) return cat;
  }
  return 'other';
}

function extractTopicTags(text: string): string[] {
  const tags: string[] = [];
  const t = text.toLowerCase();
  const tagMap: [string, RegExp][] = [
    ['starseed', /starseed/i],
    ['spirit_animal', /spirit\s*animal/i],
    ['astrology', /astrol|zodiac|horoscope/i],
    ['personality_quiz', /personality|personalit/i],
    ['weight_loss', /weight|dieta|dimagri/i],
    ['skincare', /skincare|skin\s*care|beauty/i],
    ['supplements', /supplement|integratore|probiot/i],
    ['email_capture', /email/i],
    ['checkout', /checkout|payment|trial|prezzo|\$\d+/i],
    ['palm_reading', /palm.*scan|palm.*read/i],
    ['meditation', /meditation|meditazione/i],
    ['crystal', /crystal|cristall/i],
    ['chakra', /chakra/i],
    ['lightworker', /lightworker/i],
    ['quiz_long', /(?:2[5-9]|[3-9]\d)\s*(?:step|domand|question)/i],
  ];
  for (const [tag, regex] of tagMap) {
    if (regex.test(t)) tags.push(tag);
  }
  return tags;
}

// =====================================================
// Data validation helpers
// =====================================================

function ensureStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((x) => typeof x === 'string').map(String);
}

function ensureString(val: unknown, fallback: string | null = null): string | null {
  if (typeof val === 'string' && val.trim()) return val.trim();
  return fallback;
}

const VALID_FUNNEL_TYPES = [
  'quiz_funnel', 'sales_funnel', 'landing_page', 'webinar_funnel',
  'tripwire_funnel', 'lead_magnet', 'vsl_funnel', 'other',
];

const VALID_CATEGORIES = [
  'weight_loss', 'supplements', 'skincare', 'fitness', 'finance',
  'saas', 'ecommerce', 'health', 'education', 'dating',
  'real_estate', 'crypto', 'spirituality', 'astrology', 'other',
];

// =====================================================
// Claude API call with retry
// =====================================================

async function callClaudeWithRetry(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  maxRetries: number = 2,
): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 16384,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.warn(`[save-funnel] Claude API attempt ${attempt + 1} failed: ${response.status} — ${errText.slice(0, 200)}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        return null;
      }

      const data = (await response.json()) as {
        content?: { type: string; text?: string }[];
      };
      const rawText = data.content?.find((c) => c.type === 'text')?.text ?? '';

      if (!rawText) {
        console.warn(`[save-funnel] Claude attempt ${attempt + 1}: empty response`);
        if (attempt < maxRetries) continue;
        return null;
      }

      const parsed = parseJsonFromResponse(rawText);
      if (parsed) {
        console.log(`[save-funnel] Claude JSON parsed successfully on attempt ${attempt + 1}`);
        return parsed;
      }

      console.warn(`[save-funnel] Claude attempt ${attempt + 1}: JSON parse failed (${rawText.length} chars). First 200: ${rawText.slice(0, 200)}`);
      if (attempt < maxRetries) continue;
      return null;
    } catch (err) {
      console.warn(`[save-funnel] Claude attempt ${attempt + 1} error:`, err instanceof Error ? err.message : err);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}

// =====================================================
// Supabase save with retry
// =====================================================

async function saveToSupabaseWithRetry(
  funnelData: Parameters<typeof createAffiliateSavedFunnel>[0],
  maxRetries: number = 2,
): Promise<Awaited<ReturnType<typeof createAffiliateSavedFunnel>>> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const saved = await createAffiliateSavedFunnel(funnelData);
      return saved;
    } catch (err) {
      lastError = err;
      console.warn(`[save-funnel] Supabase save attempt ${attempt + 1} failed:`, err instanceof Error ? err.message : err);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// =====================================================
// MAIN API ROUTE — ZERO-FAILURE DESIGN
// =====================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { agentResult, jobId, saveType } = body as {
      agentResult: string;
      jobId?: string;
      saveType?: 'quiz' | 'funnel';
    };

    if (!agentResult || agentResult.trim().length < 20) {
      return NextResponse.json(
        { success: false, error: 'agentResult is required and must contain sufficient data.' },
        { status: 400 }
      );
    }

    // Find the chat record if jobId provided
    let chatId: string | null = null;
    if (jobId) {
      try {
        const chat = await fetchAffiliateBrowserChatByJobId(jobId);
        chatId = chat?.id ?? null;
      } catch { /* non-blocking */ }
    }

    // ─── STEP 1: Try Claude API (with retry) ───
    let parsed: Record<string, unknown> | null = null;
    let usedFallback = false;

    const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
    if (apiKey) {
      const saveContext = saveType === 'quiz'
        ? 'The user wants to save this as a QUIZ FUNNEL. Classify the funnel_type as "quiz_funnel".'
        : saveType === 'funnel'
          ? 'The user wants to save this as a SALES FUNNEL. Classify the funnel_type based on the content.'
          : 'Classify the funnel_type based on the content.';

      const maxChars = 80000;
      const trimmedText = agentResult.length > maxChars
        ? agentResult.slice(0, maxChars) + '\n\n[...testo troncato...]'
        : agentResult;

      parsed = await callClaudeWithRetry(
        apiKey,
        STRUCTURING_PROMPT,
        `${saveContext}\n\n--- BROWSER AGENT RESULT ---\n\n${trimmedText}`,
      );
    } else {
      console.warn('[save-funnel] No ANTHROPIC_API_KEY — skipping Claude, using regex fallback');
    }

    // ─── STEP 2: If Claude failed → regex fallback ───
    if (!parsed) {
      parsed = regexFallbackParse(agentResult, saveType);
      usedFallback = true;
    }

    // ─── STEP 3: Merge regex fallback with Claude if Claude returned partial data ───
    // (e.g. Claude parsed but steps array is empty — fill from regex)
    if (parsed && (!Array.isArray(parsed.steps) || (parsed.steps as unknown[]).length === 0)) {
      const regexData = regexFallbackParse(agentResult, saveType);
      const regexSteps = regexData.steps as unknown[];
      if (regexSteps && regexSteps.length > 0) {
        parsed.steps = regexSteps;
        parsed.total_steps = regexSteps.length;
        console.log(`[save-funnel] Merged ${regexSteps.length} regex-extracted steps into Claude result`);
      }
    }

    // ─── STEP 4: Build final normalized data ───
    const funnelType = typeof parsed.funnel_type === 'string' && VALID_FUNNEL_TYPES.includes(parsed.funnel_type)
      ? parsed.funnel_type
      : (saveType === 'quiz' ? 'quiz_funnel' : 'other');

    const category = typeof parsed.category === 'string' && VALID_CATEGORIES.includes(parsed.category)
      ? parsed.category
      : inferCategory(agentResult);

    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];

    const funnelData = {
      chat_id: chatId,
      funnel_name: ensureString(parsed.funnel_name) ?? 'Unnamed Funnel',
      brand_name: ensureString(parsed.brand_name),
      entry_url: ensureString(parsed.entry_url) ?? '',
      funnel_type: funnelType,
      category,
      tags: ensureStringArray(parsed.tags),
      total_steps: typeof parsed.total_steps === 'number' ? parsed.total_steps : steps.length,
      steps: steps as unknown as import('@/types/database').Json,
      analysis_summary: ensureString(parsed.analysis_summary),
      persuasion_techniques: ensureStringArray(parsed.persuasion_techniques),
      lead_capture_method: ensureString(parsed.lead_capture_method),
      notable_elements: ensureStringArray(parsed.notable_elements),
      raw_agent_result: agentResult,
    };

    // ─── STEP 5: Save to Supabase (with retry) ───
    const saved = await saveToSupabaseWithRetry(funnelData);

    return NextResponse.json({
      success: true,
      funnel: {
        id: saved.id,
        funnel_name: saved.funnel_name,
        brand_name: saved.brand_name,
        funnel_type: saved.funnel_type,
        category: saved.category,
        total_steps: saved.total_steps,
        tags: saved.tags,
        analysis_summary: saved.analysis_summary,
      },
      usedFallback,
      message: `Funnel "${saved.funnel_name}" saved successfully as ${saved.funnel_type} (${saved.category})${usedFallback ? ' [regex fallback]' : ''}`,
    });
  } catch (error) {
    // ─── LAST RESORT: Save with absolute minimum data ───
    console.error('[save-funnel] Critical error, attempting last-resort save:', error);

    try {
      const body = await request.clone().json().catch(() => null);
      const agentResult = (body as Record<string, unknown>)?.agentResult;
      if (typeof agentResult === 'string' && agentResult.length > 20) {
        const minimalData = regexFallbackParse(agentResult, (body as Record<string, unknown>)?.saveType as 'quiz' | 'funnel' | undefined);
        const steps = Array.isArray(minimalData.steps) ? minimalData.steps : [];

        const saved = await createAffiliateSavedFunnel({
          chat_id: null,
          funnel_name: ensureString(minimalData.funnel_name) ?? 'Funnel (emergency save)',
          brand_name: ensureString(minimalData.brand_name),
          entry_url: ensureString(minimalData.entry_url) ?? '',
          funnel_type: (ensureString(minimalData.funnel_type) as string) ?? 'other',
          category: (ensureString(minimalData.category) as string) ?? 'other',
          tags: ensureStringArray(minimalData.tags),
          total_steps: steps.length,
          steps: steps as unknown as import('@/types/database').Json,
          analysis_summary: 'Emergency save — Claude analysis not available.',
          persuasion_techniques: ensureStringArray(minimalData.persuasion_techniques),
          lead_capture_method: ensureString(minimalData.lead_capture_method),
          notable_elements: ensureStringArray(minimalData.notable_elements),
          raw_agent_result: agentResult,
        });

        return NextResponse.json({
          success: true,
          funnel: {
            id: saved.id,
            funnel_name: saved.funnel_name,
            brand_name: saved.brand_name,
            funnel_type: saved.funnel_type,
            category: saved.category,
            total_steps: saved.total_steps,
            tags: saved.tags,
            analysis_summary: saved.analysis_summary,
          },
          usedFallback: true,
          emergencySave: true,
          message: `Funnel "${saved.funnel_name}" saved in emergency mode (${saved.total_steps} steps extracted)`,
        });
      }
    } catch (emergencyErr) {
      console.error('[save-funnel] Emergency save also failed:', emergencyErr);
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Critical error during save',
      },
      { status: 500 }
    );
  }
}
