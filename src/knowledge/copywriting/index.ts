/**
 * Copywriting Knowledge Base — Tier-based loader
 *
 * Tier 1 (always loaded, ~28K tokens):
 *   COS-Engine + 5 distilled frameworks. Always injected as a CACHED
 *   block in the system prompt. Anthropic Prompt Caching makes the cost
 *   ~10% on hits within ~5 min.
 *
 * Tier 2 (task-specific, optional add-ons):
 *   Per-task expansions distilled from RMBC, Swipe Mastery, Copy Coders,
 *   VSL Masterclass and Ad Creatives Academy. Selected per CopywritingTask
 *   and capped by MAX_TIER2_TOKENS to keep the system prompt manageable.
 *
 * Tier 3 (archive only, not loaded at runtime):
 *   Full RMBC ~110K tokens. Reserved for future RAG. Files exist on disk
 *   but are NEVER auto-included in any task. Loadable only via
 *   loadArchiveSource() when a caller explicitly opts in.
 *
 * Usage:
 *   import { getKnowledgeBundleForTask } from '@/knowledge/copywriting';
 *   const kb = getKnowledgeBundleForTask('pdp'); // Tier 1 + curated Tier 2
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KB_DIR = join(process.cwd(), 'src', 'knowledge', 'copywriting', 'raw');

/** Hard cap on Tier 2 tokens added to the system prompt for any task.
 *  Prevents accidental blow-ups when many sources match a task. */
const MAX_TIER2_TOKENS = 35000;

export type CopywritingTask =
  | 'general'      // chat, brief analysis, generic strategic copywriting
  | 'vsl'          // VSL / long-form sales letter
  | 'pdp'          // landing page / product detail page
  | 'headline'     // headlines, leads, hooks
  | 'email'        // email sequences
  | 'ad'           // paid social ads, native, search
  | 'advertorial'  // advertorials
  | 'upsell'       // post-purchase upsells / OTOs
  | 'split-test'   // CRO / split-test reasoning
  | 'mechanism';   // building unique mechanisms

export interface KnowledgeSource {
  id: string;
  title: string;
  filename: string;
  /** Tier 1 = always loaded. Tier 2 = optional per-task add-on.
   *  Tier 3 = archive only (never auto-loaded). */
  tier: 1 | 2 | 3;
  /** Which tasks should this be added to (Tier 2 only). */
  tasks?: CopywritingTask[];
  /** Approximate tokens (for budgeting/logging). */
  approxTokens: number;
  /** Tier 2 priority within a task. Higher loads first; ties broken by
   *  smaller approxTokens. Used when budget is tight. Default 50. */
  priority?: number;
}

const SOURCES: KnowledgeSource[] = [
  /* ──────────────────── Tier 1 — always loaded ──────────────────── */
  {
    id: 'cos-engine',
    title: 'Conversion Operating System (COS Engine)',
    filename: 'cos-engine.md',
    tier: 1,
    approxTokens: 17000,
  },
  {
    id: 'tony-flores-mechanisms',
    title: 'Tony Flores — Million Dollar Mechanisms',
    filename: 'tony-flores-mechanisms.md',
    tier: 1,
    approxTokens: 2000,
  },
  {
    id: 'evaldo-16-word',
    title: 'Evaldo Albuquerque — The 16-Word Sales Letter',
    filename: 'evaldo-16-word.md',
    tier: 1,
    approxTokens: 3500,
  },
  {
    id: 'anghelache-crash-course',
    title: 'John L. Anghelache — Copywriting Crash Course (distilled)',
    filename: 'anghelache-crash-course.md',
    tier: 1,
    approxTokens: 3000,
  },
  {
    id: 'savage-system',
    title: 'Peter Kell — Savage Advertising System',
    filename: 'savage-system.md',
    tier: 1,
    approxTokens: 2000,
  },
  {
    id: '108-split-tests',
    title: 'Russell Brunson — 108 Proven Split Test Winners',
    filename: '108-split-tests.md',
    tier: 1,
    approxTokens: 800,
  },

  /* ──────────────────── Tier 2 — task-specific add-ons ─────────── */
  {
    id: 'landing-page-copyrecipes',
    title: 'Landing-Page Copy Recipes by HTML tag',
    filename: 'landing-page-copyrecipes.md',
    tier: 2,
    tasks: ['pdp', 'advertorial', 'upsell'],
    approxTokens: 3500,
    priority: 100, // tag-mapped recipes — load first for landing-page rewrites
  },
  {
    id: 'cc-27-headlines',
    title: 'Copy Coders — 27 AI Copy Codes: Headlines',
    filename: 'cc-27-headlines.md',
    tier: 2,
    tasks: ['headline', 'pdp', 'advertorial', 'vsl', 'ad'],
    approxTokens: 1600,
    priority: 95,
  },
  {
    id: 'sg-l63-big-ideas',
    title: 'Stefan Georgi — Breakthrough BIG Ideas (5-step process)',
    filename: 'sg-l63-big-ideas.md',
    tier: 2,
    tasks: ['vsl', 'pdp', 'advertorial', 'headline', 'mechanism'],
    approxTokens: 5800,
    priority: 90,
  },
  {
    id: 'sg-l62-income-psychographics',
    title: 'Stefan Georgi — Income Opportunity Market Psychographics',
    filename: 'sg-l62-income-psychographics.md',
    tier: 2,
    tasks: ['vsl', 'pdp', 'advertorial', 'ad'],
    approxTokens: 7500,
    priority: 80,
  },
  {
    id: 'vsl-masterclass-community',
    title: 'VSL Masterclass — Community insights (Fernando Oliver / Jessica Reosa)',
    filename: 'vsl-masterclass-community.md',
    tier: 2,
    tasks: ['vsl', 'advertorial', 'headline'],
    approxTokens: 11000,
    priority: 60,
  },
  {
    id: 'ad-creatives-academy-posts',
    title: 'Ad Creatives Academy — Community posts (99ads)',
    filename: 'ad-creatives-academy-posts.md',
    tier: 2,
    tasks: ['ad'],
    approxTokens: 5800,
    priority: 70,
  },
  {
    id: 'ad-creatives-academy-top',
    title: 'Ad Creatives Academy — Top posts (99ads)',
    filename: 'ad-creatives-academy-top.md',
    tier: 2,
    tasks: ['ad'],
    approxTokens: 1000,
    priority: 75,
  },
  {
    id: 'advanced-ai-hooks-transcript',
    title: 'Advanced AI Hooks — Workshop call transcript (Copy Coders)',
    filename: 'advanced-ai-hooks-transcript.md',
    tier: 2,
    tasks: ['headline', 'ad', 'vsl'],
    approxTokens: 27000,
    priority: 30, // big file — only loads when budget allows
  },

  /* ──────────────────── Tier 3 — archive only ──────────────────── */
  {
    id: 'sg-rmbc-complete',
    title: 'Stefan Georgi — RMBC II Complete Course (full archive)',
    filename: 'sg-rmbc-complete.md',
    tier: 3,
    approxTokens: 110000,
  },
];

/** In-memory cache so we read each file once per server process. */
const _cache = new Map<string, string>();

function loadSource(src: KnowledgeSource): string | null {
  const cached = _cache.get(src.id);
  if (cached !== undefined) return cached;

  try {
    const content = readFileSync(join(KB_DIR, src.filename), 'utf-8').trim();
    _cache.set(src.id, content);
    return content;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(
        `[knowledge/copywriting] Missing file: ${src.filename}. ` +
        `Run scripts/setup-knowledge.ps1 (and import-new-kb-2026-05-07.ps1) to populate it.`,
      );
      _cache.set(src.id, '');
      return null;
    }
    throw err;
  }
}

function frameSection(src: KnowledgeSource, body: string): string {
  return [
    `<knowledge_source id="${src.id}" title="${src.title}">`,
    body,
    `</knowledge_source>`,
  ].join('\n');
}

/**
 * Returns the Tier 1 knowledge as a single string, ready to be used as
 * a CACHED system block. Sources with missing files are skipped.
 */
export function getCoreKnowledge(): string {
  const blocks: string[] = [];
  blocks.push(
    '# COPYWRITING KNOWLEDGE BASE — TIER 1 (CORE)',
    '',
    'You have been trained on (and have direct access to) the following',
    'direct-response copywriting frameworks. Use them as the FOUNDATION',
    'of every copywriting decision. When the user asks for output, you',
    'should silently apply these frameworks; only cite them by name when',
    'explicitly asked or when it materially helps the user understand',
    'a recommendation.',
    '',
    '---',
    '',
  );

  for (const src of SOURCES.filter((s) => s.tier === 1)) {
    const body = loadSource(src);
    if (!body) continue;
    blocks.push(frameSection(src, body));
    blocks.push('');
  }

  return blocks.join('\n');
}

/**
 * Returns task-specific Tier 2 knowledge. Sources are selected by task,
 * sorted by priority (desc) then by size (asc), and packed greedily up
 * to MAX_TIER2_TOKENS. Returned string is meant to be appended to
 * getCoreKnowledge() and shipped as a single cached system block.
 *
 * Empty string when no Tier-2 source is registered for the given task
 * (or when none of them load successfully).
 */
export function getKnowledgeForTask(task: CopywritingTask): string {
  const matched = SOURCES.filter(
    (s) => s.tier === 2 && (s.tasks?.includes(task) ?? false),
  );
  if (matched.length === 0) return '';

  const sorted = [...matched].sort((a, b) => {
    const pa = a.priority ?? 50;
    const pb = b.priority ?? 50;
    if (pa !== pb) return pb - pa;
    return a.approxTokens - b.approxTokens;
  });

  const blocks: string[] = [];
  const included: KnowledgeSource[] = [];
  let budget = MAX_TIER2_TOKENS;

  for (const src of sorted) {
    if (src.approxTokens > budget) continue;
    const body = loadSource(src);
    if (!body) continue;
    blocks.push(frameSection(src, body));
    blocks.push('');
    included.push(src);
    budget -= src.approxTokens;
  }

  if (included.length === 0) return '';

  const header = [
    `# COPYWRITING KNOWLEDGE BASE — TIER 2 (TASK: ${task.toUpperCase()})`,
    '',
    'These are tactical, ready-to-apply techniques for the current task.',
    'Treat them as an executable checklist — every output must conform.',
    `Sources loaded (${included.length}): ${included.map((s) => s.id).join(', ')}.`,
    '',
    '---',
    '',
  ].join('\n');

  return header + '\n' + blocks.join('\n');
}

/**
 * Convenience: returns Tier 1 + Tier 2 (if any) joined as a single
 * KB blob, ready to be sent as a single cached system block.
 */
export function getKnowledgeBundleForTask(task: CopywritingTask): string {
  const t1 = getCoreKnowledge();
  const t2 = getKnowledgeForTask(task);
  return t2 ? `${t1}\n\n${t2}` : t1;
}

/**
 * Explicitly load a Tier 3 archive source by id. Use only when a caller
 * is OK with a very large injection (e.g. a long-running RMBC analysis).
 * Returns null when the source isn't tier 3 or the file is missing.
 */
export function loadArchiveSource(id: string): string | null {
  const src = SOURCES.find((s) => s.id === id && s.tier === 3);
  if (!src) return null;
  const body = loadSource(src);
  if (!body) return null;
  return frameSection(src, body);
}

/** Lightweight summary for /api/health and debugging. */
export function getKnowledgeStats() {
  const sources = SOURCES.map((src) => {
    const content = loadSource(src);
    return {
      id: src.id,
      title: src.title,
      tier: src.tier,
      tasks: src.tasks ?? null,
      loaded: content !== null && content.length > 0,
      chars: content?.length ?? 0,
      approxTokens: src.approxTokens,
    };
  });
  const totalApproxTokens = sources
    .filter((s) => s.loaded && s.tier === 1)
    .reduce((sum, s) => sum + s.approxTokens, 0);
  return {
    sources,
    tier1ApproxTokens: totalApproxTokens,
    maxTier2Tokens: MAX_TIER2_TOKENS,
  };
}

/** List the (sorted) Tier-2 sources that would be packed for a task,
 *  along with the resulting token budget usage. Pure introspection — no
 *  file I/O. Useful for debugging and for the /api/health endpoint. */
export function getTaskPlan(task: CopywritingTask) {
  const matched = SOURCES.filter(
    (s) => s.tier === 2 && (s.tasks?.includes(task) ?? false),
  );
  const sorted = [...matched].sort((a, b) => {
    const pa = a.priority ?? 50;
    const pb = b.priority ?? 50;
    if (pa !== pb) return pb - pa;
    return a.approxTokens - b.approxTokens;
  });

  const included: { id: string; approxTokens: number }[] = [];
  const skipped: { id: string; approxTokens: number; reason: string }[] = [];
  let budget = MAX_TIER2_TOKENS;
  for (const src of sorted) {
    if (src.approxTokens > budget) {
      skipped.push({
        id: src.id,
        approxTokens: src.approxTokens,
        reason: `exceeds remaining budget (${budget} left)`,
      });
      continue;
    }
    included.push({ id: src.id, approxTokens: src.approxTokens });
    budget -= src.approxTokens;
  }

  const tier1 = SOURCES.filter((s) => s.tier === 1).reduce(
    (sum, s) => sum + s.approxTokens,
    0,
  );
  const tier2 = included.reduce((sum, s) => sum + s.approxTokens, 0);
  return {
    task,
    tier1ApproxTokens: tier1,
    tier2ApproxTokens: tier2,
    totalApproxTokens: tier1 + tier2,
    maxTier2Tokens: MAX_TIER2_TOKENS,
    included,
    skipped,
  };
}
