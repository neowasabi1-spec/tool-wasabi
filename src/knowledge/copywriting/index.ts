/**
 * Copywriting Knowledge Base — Tier-based loader
 *
 * Tier 1 (always loaded, ~30K tokens):
 *   COS-Engine + 5 distilled frameworks. Always injected as a CACHED
 *   block in the system prompt. Anthropic Prompt Caching makes the cost
 *   ~10% on hits within ~5 min.
 *
 * Tier 2 (task-specific, optional add-ons):
 *   Per-task expansions distilled from RMBC and Swipe Mastery.
 *   NOT YET POPULATED — Phase 2 work.
 *
 * Tier 3 (archive only, not loaded at runtime):
 *   Full RMBC and full Swipe Mastery PDFs. Reserved for future RAG.
 *
 * Usage:
 *   import { getCoreKnowledge, getKnowledgeForTask } from '@/knowledge/copywriting';
 *
 *   const core = getCoreKnowledge();          // Tier 1, always
 *   const pack = getKnowledgeForTask('vsl');  // Tier 2 add-on (may be empty)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KB_DIR = join(process.cwd(), 'src', 'knowledge', 'copywriting', 'raw');

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
  /** Tier 1 = always loaded. Tier 2 = optional add-on per task. */
  tier: 1 | 2;
  /** Which tasks should this be added to (Tier 2 only). */
  tasks?: CopywritingTask[];
  /** Approximate tokens (for budgeting/logging). */
  approxTokens: number;
}

const SOURCES: KnowledgeSource[] = [
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
        `Run scripts/setup-knowledge.ps1 to populate it.`
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

  for (const src of SOURCES.filter(s => s.tier === 1)) {
    const body = loadSource(src);
    if (!body) continue;
    blocks.push(frameSection(src, body));
    blocks.push('');
  }

  return blocks.join('\n');
}

/**
 * Returns task-specific Tier 2 knowledge (may be empty in Phase 1).
 * Returned string is meant to be added as an additional CACHED block.
 */
export function getKnowledgeForTask(_task: CopywritingTask): string {
  return '';
}

/** Lightweight summary for /api/health and debugging. */
export function getKnowledgeStats() {
  const stats = SOURCES.map(src => {
    const content = loadSource(src);
    return {
      id: src.id,
      title: src.title,
      tier: src.tier,
      loaded: content !== null && content.length > 0,
      chars: content?.length ?? 0,
      approxTokens: src.approxTokens,
    };
  });
  const totalApproxTokens = stats
    .filter(s => s.loaded)
    .reduce((sum, s) => sum + s.approxTokens, 0);
  return { sources: stats, totalApproxTokens };
}
