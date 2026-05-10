// Smart routing of project section files to Claude based on the page type
// being rewritten. Goal: send Claude only the documents that are relevant to
// the current page (always include the foundational ones; include
// page-type-specific ones only when they match).
//
// Pure logic, no I/O. Used by:
//   - the rewrite proxy (server-side selection before forwarding to the
//     Supabase Edge Function)
//   - the projects page UI (per-file routing tags + preview panel)
//
// All matching is case-insensitive and operates on filename TOKENS so that
// "PLASTILEAN_VSL_SCRIPT_V6.txt" and "plastilean-vsl-script-v6.txt" produce
// the same classification. We deliberately also match keywords inside file
// content as a fallback, because some users name files generically
// ("doc1.pdf") but include obvious section headers like "VSL SCRIPT".

import type { SectionFile } from './project-sections';

// ─── PageType → CopywritingTask mapping ──────────────────────────────────────
// Mirrors the BuiltInPageType union from src/types/index.ts. Anything not
// listed defaults to 'pdp' (the existing behaviour).

export type CopywritingTask =
  | 'general'
  | 'vsl'
  | 'pdp'
  | 'headline'
  | 'email'
  | 'ad'
  | 'advertorial'
  | 'upsell'
  | 'split-test'
  | 'mechanism';

const PAGE_TYPE_TO_TASK: Record<string, CopywritingTask> = {
  // VSL family
  vsl: 'vsl',
  sales_letter: 'vsl',
  webinar: 'vsl',
  bridge_page: 'vsl',
  // Advertorial family
  advertorial: 'advertorial',
  listicle: 'advertorial',
  '5_reasons_listicle': 'advertorial',
  native_ad: 'advertorial',
  // Landing / PDP family
  landing: 'pdp',
  opt_in: 'pdp',
  squeeze_page: 'pdp',
  lead_magnet: 'pdp',
  product_page: 'pdp',
  offer_page: 'pdp',
  quiz_funnel: 'pdp',
  survey: 'pdp',
  assessment: 'pdp',
  checkout: 'pdp',
  // Post-purchase family
  upsell: 'upsell',
  downsell: 'upsell',
  oto: 'upsell',
  thank_you: 'upsell',
  order_confirmation: 'upsell',
  membership: 'upsell',
  // Content
  blog: 'general',
  article: 'general',
  content_page: 'general',
  review: 'pdp',
  // Compliance
  safe_page: 'general',
  privacy: 'general',
  terms: 'general',
  disclaimer: 'general',
};

export function pageTypeToTask(pageType: string | undefined | null): CopywritingTask {
  if (!pageType) return 'pdp';
  return PAGE_TYPE_TO_TASK[pageType] ?? 'pdp';
}

// ─── File classification rules ───────────────────────────────────────────────
// Each rule is a list of keywords. A file matches a rule when ANY of its
// tokens equals (or contains) one of the keywords. We match on tokens to
// avoid false positives like "VAL" matching "vsl" (token equality).

interface ClassificationRule {
  /** Page types this content is relevant for. Empty = always include. */
  pageTypes: string[];
  /** Filename / content keywords that trigger this rule. */
  keywords: string[];
  /** Human-readable label for the UI. */
  label: string;
  /** Lower = more important when budget is tight. 1 = always-include. */
  priority: number;
}

const RULES: ClassificationRule[] = [
  // ─── Foundational (always loaded) ──────────────────────────────────────────
  {
    label: 'Brand & positioning',
    pageTypes: [],
    keywords: ['brand', 'colors', 'colours', 'palette', 'positioning', 'usp', 'promise', 'voice', 'tone', 'identity'],
    priority: 1,
  },
  {
    label: 'Avatar / persona',
    pageTypes: [],
    keywords: ['avatar', 'persona', 'icp', 'audience', 'target', 'buyer', 'demographic'],
    priority: 1,
  },
  {
    label: 'Belief / narrative',
    pageTypes: [],
    keywords: ['belief', 'beliefs', 'narrative', 'story', 'journey', 'arc'],
    priority: 1,
  },
  {
    label: 'Mechanism / big idea',
    pageTypes: [],
    keywords: ['mechanism', 'mechanisms', 'bigidea', 'big_idea', 'bigideas', 'breakthrough', 'angle'],
    priority: 1,
  },
  {
    label: 'Brief / strategy',
    pageTypes: [],
    keywords: ['brief', 'briefing', 'strategy', 'strategic', 'rulebook', 'rule', 'rules', 'bible', 'playbook', 'guidelines'],
    priority: 1,
  },
  {
    label: 'Compliance / legal',
    pageTypes: [],
    keywords: ['compliance', 'legal', 'disclaimer', 'gdpr', 'privacy', 'terms', 'risk'],
    priority: 1,
  },
  {
    label: 'Headlines / hooks',
    pageTypes: [],
    keywords: ['headline', 'headlines', 'hook', 'hooks', 'leads', 'titles'],
    priority: 2,
  },

  // ─── Page-type-specific ────────────────────────────────────────────────────
  {
    label: 'VSL script',
    pageTypes: ['vsl', 'sales_letter', 'webinar', 'bridge_page', 'advertorial'],
    keywords: ['vsl', 'script', 'video', 'webinar', 'sales_letter', 'salesletter'],
    priority: 5,
  },
  {
    label: 'Landing / PDP copy',
    pageTypes: ['landing', 'opt_in', 'squeeze_page', 'lead_magnet', 'product_page', 'offer_page'],
    keywords: ['landing', 'pdp', 'product_page', 'productpage', 'optin', 'opt_in', 'squeeze', 'leadmagnet', 'lead_magnet'],
    priority: 5,
  },
  {
    label: 'OTO / upsell copy',
    pageTypes: ['oto', 'upsell', 'downsell', 'thank_you', 'order_confirmation', 'membership'],
    keywords: ['oto', 'upsell', 'downsell', 'bump', 'crosssell', 'cross_sell', 'thankyou', 'membership'],
    priority: 5,
  },
  {
    label: 'Quiz / survey copy',
    pageTypes: ['quiz_funnel', 'survey', 'assessment'],
    keywords: ['quiz', 'survey', 'assessment', 'questionnaire'],
    priority: 5,
  },
  {
    label: 'Checkout / order copy',
    pageTypes: ['checkout'],
    keywords: ['checkout', 'order_form', 'orderform', 'cart', 'payment'],
    priority: 5,
  },
  {
    label: 'Advertorial / listicle copy',
    pageTypes: ['advertorial', 'listicle', '5_reasons_listicle', 'native_ad'],
    keywords: ['advertorial', 'listicle', 'native', 'editorial', 'article'],
    priority: 5,
  },
  {
    label: 'Email sequence',
    pageTypes: [], // never loaded for swipe — kept as opt-in only
    keywords: ['email', 'emails', 'sequence', 'newsletter', 'autoresponder'],
    priority: 9,
  },
];

// ─── Classification ──────────────────────────────────────────────────────────

export interface FileClassification {
  /** All matched rules (a file can hit several, e.g. "VSL_AVATAR.txt"). */
  matched: ClassificationRule[];
  /** Human-readable tags for the UI (deduped, ordered by priority). */
  tags: string[];
  /** True when the file should be included regardless of pageType. */
  isFoundational: boolean;
  /** Page types this file is relevant for. Empty = always. */
  pageTypes: string[];
  /** Effective priority used for budget packing (lower = include first). */
  priority: number;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '') // strip extension
    .split(/[\s_\-./\\]+/)
    .filter(Boolean);
}

function ruleMatches(rule: ClassificationRule, tokens: string[], contentSample: string): boolean {
  for (const kw of rule.keywords) {
    // Token equality first (cleanest signal).
    if (tokens.includes(kw)) return true;
    // Substring fallback for camel-case or merged words.
    if (tokens.some((t) => t.includes(kw))) return true;
  }
  // Last-resort: scan the first 1KB of content for the keyword as a
  // standalone word. Keeps generic names like "doc1.pdf" from being
  // mis-routed when the body says "VSL SCRIPT" loud and clear.
  if (contentSample) {
    const head = contentSample.slice(0, 1024).toLowerCase();
    for (const kw of rule.keywords) {
      const re = new RegExp(`\\b${kw.replace(/[_-]/g, '[ _-]?')}\\b`);
      if (re.test(head)) return true;
    }
  }
  return false;
}

export function classifyFile(file: SectionFile): FileClassification {
  const tokens = tokenize(file.name || '');
  const matched: ClassificationRule[] = [];
  for (const rule of RULES) {
    if (ruleMatches(rule, tokens, file.content)) matched.push(rule);
  }
  const isFoundational = matched.some((r) => r.pageTypes.length === 0 && r.priority <= 2);
  const pageTypes = Array.from(new Set(matched.flatMap((r) => r.pageTypes)));
  const tags = matched.map((r) => r.label);
  const priority = matched.length === 0 ? 7 : Math.min(...matched.map((r) => r.priority));
  return { matched, tags, isFoundational, pageTypes, priority };
}

// ─── Selection by page type with budget ──────────────────────────────────────

export interface SelectionResult {
  selected: SectionFile[];
  skipped: { file: SectionFile; reason: string }[];
  totalChars: number;
  budgetChars: number;
}

const FILE_OVERHEAD_CHARS = 32; // approx for "=== FILE: name ===" divider

/** Decide whether a file should be considered for the given pageType. */
function isFileRelevantForPageType(c: FileClassification, pageType: string): boolean {
  if (c.matched.length === 0) return true; // unclassified → include by default
  if (c.isFoundational) return true;
  if (c.pageTypes.length === 0) return true; // matched only foundational rules
  return c.pageTypes.includes(pageType);
}

export function selectFilesForPageType(
  files: SectionFile[],
  pageType: string,
  charBudget: number,
): SelectionResult {
  const annotated = files.map((f) => ({ f, c: classifyFile(f) }));

  // First pass: drop files that are page-type-specific and don't match.
  const eligible: { f: SectionFile; c: FileClassification }[] = [];
  const skipped: { file: SectionFile; reason: string }[] = [];
  for (const a of annotated) {
    if (isFileRelevantForPageType(a.c, pageType)) {
      eligible.push(a);
    } else {
      skipped.push({
        file: a.f,
        reason: `page-type "${pageType}" not in [${a.c.pageTypes.join(', ')}]`,
      });
    }
  }

  // Sort eligible by priority (lower first), then by smaller-first inside the
  // same priority — packs more files into the budget.
  eligible.sort((a, b) => {
    if (a.c.priority !== b.c.priority) return a.c.priority - b.c.priority;
    return a.f.content.length - b.f.content.length;
  });

  // Greedy pack within the char budget. Foundational files get a guaranteed
  // attempt even if oversized: we trim them to fit instead of dropping.
  const selected: SectionFile[] = [];
  let used = 0;
  for (const a of eligible) {
    const need = a.f.content.length + FILE_OVERHEAD_CHARS;
    const remaining = charBudget - used;
    if (remaining <= FILE_OVERHEAD_CHARS) {
      skipped.push({ file: a.f, reason: 'budget exhausted' });
      continue;
    }
    if (need <= remaining) {
      selected.push(a.f);
      used += need;
      continue;
    }
    // Doesn't fit whole. Trim foundational files to fit; drop the rest.
    if (a.c.isFoundational || a.c.matched.length === 0) {
      const trimmedSize = Math.max(0, remaining - FILE_OVERHEAD_CHARS - 200); // leave room for "[truncated]"
      if (trimmedSize > 1024) {
        selected.push({
          ...a.f,
          content: a.f.content.slice(0, trimmedSize) + '\n\n[... file truncated to fit Claude budget ...]',
          name: a.f.name,
        });
        used += trimmedSize + FILE_OVERHEAD_CHARS + 200;
      } else {
        skipped.push({ file: a.f, reason: 'no room even after trim' });
      }
    } else {
      skipped.push({
        file: a.f,
        reason: `too large for remaining budget (${a.f.content.length} > ${remaining})`,
      });
    }
  }

  return { selected, skipped, totalChars: used, budgetChars: charBudget };
}

// ─── Section content builder (replacement for buildSectionContent when
//     a pageType is known) ─────────────────────────────────────────────────

export function buildRoutedSectionContent(
  files: SectionFile[],
  notes: string,
  pageType: string,
  charBudget: number,
): { content: string; selection: SelectionResult } {
  const selection = selectFilesForPageType(files, pageType, charBudget);
  const parts: string[] = [];
  for (const f of selection.selected) {
    if (!f.content?.trim()) continue;
    parts.push(`=== FILE: ${f.name} ===\n\n${f.content.trim()}`);
  }
  if (notes?.trim()) {
    parts.push(`=== NOTES ===\n\n${notes.trim()}`);
  }
  const content = parts.join('\n\n').trim();
  return { content, selection };
}
