// System prompts and JSON-schema instructions for each Checkpoint
// category. Kept in a single file so prompt engineering is one
// concern, not scattered across route handlers.
//
// All prompts return STRICT JSON in the same shape so the API route
// can validate / persist uniformly:
//
//   {
//     "score": 0-100,
//     "summary": "one paragraph executive summary",
//     "issues": [
//       { "severity": "critical|warning|info",
//         "title": "short bold label",
//         "detail": "longer explanation",
//         "evidence": "optional copy snippet" }
//     ],
//     "suggestions": [
//       { "title": "actionable fix", "detail": "how / why" }
//     ]
//   }

import type { CheckpointCategory } from '@/types/checkpoint';
import type { CopywritingTask } from '@/knowledge/copywriting';

interface CategoryPromptConfig {
  /** What knowledge tier to inject (drives the Tier 2 KB block). */
  task: CopywritingTask;
  /** Persona / role-specific instructions sent as system block. */
  instructions: string;
  /** Per-call max output tokens — small, this is structured JSON. */
  maxTokens: number;
}

const SHARED_OUTPUT_FORMAT = `
OUTPUT FORMAT — return ONE valid JSON object, no markdown fence, no prose:

{
  "score": <integer 0-100>,
  "summary": "<one paragraph, max 3 sentences, exec summary of the audit>",
  "issues": [
    {
      "severity": "critical" | "warning" | "info",
      "title": "<short bold label, max 80 chars>",
      "detail": "<1-3 sentences explanation>",
      "evidence": "<optional verbatim copy snippet from the page, max 200 chars>"
    }
  ],
  "suggestions": [
    {
      "title": "<actionable fix headline, max 80 chars>",
      "detail": "<1-2 sentences with the exact change to make>"
    }
  ]
}

Scoring rubric (be honest, not generous):
- 90-100  Excellent. Few or no issues, all best practices in place.
- 80-89   Good. Minor improvements possible.
- 65-79   Mediocre. Several real issues that hurt performance.
- 50-64   Weak. Multiple critical problems.
- 0-49    Broken. Fundamental flaws.

Rules:
- Issue ordering: critical first, then warning, then info.
- Issue count: 0 to 8. Don't pad.
- Suggestions: maximum 5, only HIGH-IMPACT fixes.
- Stay focused on YOUR category — don't audit unrelated dimensions.
- All "evidence" snippets MUST appear verbatim in the input HTML/text.
- If the page is not analyzable for your category (e.g. empty, wrong language), return score=null and put a single warning issue explaining why.
`;

export const CATEGORY_PROMPT_CONFIG: Record<
  CheckpointCategory,
  CategoryPromptConfig
> = {
  navigation: {
    task: 'general',
    maxTokens: 3000,
    instructions: `You are a senior funnel architect auditing the END-TO-END NAVIGATION of a multi-step sales funnel.

You receive an ORDERED sequence of pages (step 1 = landing, step N = thank-you / final). For EACH transition between consecutive steps you verify two layers:

(A) TECHNICAL INTEGRITY — link/CTA reachability
- The primary CTA on step K visibly points to step K+1 (or to a checkout / external processor that logically belongs at that position).
- No CTA on a non-final step is dead, anchor-only (#), mailto:, javascript:void(0), or pointing back to the same step.
- No 404-shaped link text ("page not found", "coming soon", lorem placeholders).
- Tracking parameters / domains stay consistent across steps (no leak from www.brand.com to a Replit preview URL on step 3).
- If step K is a checkout, it carries a price / button / form — not just marketing copy.

(B) FLOW LOGIC — does each step set up the next?
- The headline / promise on step K+1 echoes the offer on step K (no abrupt change of product, audience, or angle).
- The CTA verb on step K matches what step K+1 actually delivers ("Get my free guide" → step K+1 shows the guide download, not a generic sales letter).
- Awareness ladder: solution-aware copy on step K is followed by buying-decision copy on step K+1, not a regression to problem-aware.
- No duplicate / wasted steps (two consecutive "thank you" pages, two consecutive sales letters with the same offer, etc.).
- The final step actually closes the loop (confirmation, next-action, upsell only if positioned as such).

Quote the EXACT CTA text and the EXACT next-step headline you compared. When a transition fails, say which transition (e.g. "step 2 → step 3").

If only ONE step was supplied, you cannot audit transitions: return score=null with one warning issue ("Navigazione richiede almeno 2 step nel funnel.") and zero suggestions.
${SHARED_OUTPUT_FORMAT}`,
  },

  cro: {
    task: 'general',
    maxTokens: 2500,
    instructions: `You are a senior CRO consultant auditing a sales funnel page.

You score the page on CONVERSION RATE OPTIMIZATION fundamentals:
- Above-the-fold clarity: in <5s, can the visitor answer "what is this, who is it for, what's the next step"?
- Value proposition strength: is the unique mechanism / outcome clear?
- CTA quality: visible, action-verbed, friction-light, repeated through the page?
- Social proof: testimonials, ratings, badges — specific, believable, near the CTA?
- Urgency / scarcity: present and ETHICAL (no fake countdowns, no fake stock)?
- Friction reduction: clear pricing, refund visibility, FAQ addressing common objections?
- Visual hierarchy: scannable headers, no wall of text, contrast for CTAs?
- Mobile-first signals: short paragraphs, large tap targets, no tiny fonts?

Be ruthlessly specific — quote the exact CTA text, the exact headline, the exact testimonial copy.
${SHARED_OUTPUT_FORMAT}`,
  },

  coherence: {
    task: 'general',
    maxTokens: 3000,
    instructions: `You are an editor checking a multi-step sales funnel for INTERNAL COHERENCE — across ALL pages provided, not just one.

You verify (BOTH within each step AND across steps):
- Claim vs proof: every bold claim ("X% reduction", "4.3/5 stars", "scientifically proven") has supporting evidence on the same page or a clearly-referenced earlier step.
- Promise vs guarantee: the headline promise on step 1 matches what the guarantee on the checkout / final step actually covers (timeframe, scope, conditions).
- Mechanism vs benefit: the "WHY it works" mechanism is the SAME label across steps (no "EMS" on step 1 and "vibration therapy" on step 3 with no bridge).
- Audience consistency: the "who is this for" stays stable across the whole funnel (no "for athletes" on step 1 + "for grandmas with arthritis" on step 4 without a unifying frame).
- Offer / pricing consistency: price, bonuses, shipping, refund window MUST match across every step that mentions them. Mismatches between landing-quoted price and checkout-displayed price are CRITICAL.
- Tone consistency across steps: no clinical "GLP-1 receptor agonist" paragraph on step 2 next to "OMG you have to try this!" on step 3.
- Brand identity: name, logo positioning, brand colors / hero imagery don't drift between steps (often a sign of leftover template content).

When you flag a contradiction, name BOTH steps and quote the two clashing snippets verbatim (e.g. 'Step 1 says "$67 lifetime", Step 4 checkout shows "$97/month"').
${SHARED_OUTPUT_FORMAT}`,
  },

  tov: {
    task: 'general',
    maxTokens: 2200,
    instructions: `You are a brand voice strategist auditing a sales funnel page for TONE OF VOICE.

When a brand profile is supplied (in the user message), audit against it. When it's not, infer the intended voice from the page itself (formal/casual, scientific/anecdotal, urgent/calm, audience age/gender) and check consistency.

You check:
- Voice register: consistent (formal vs casual, "you" vs "we", first person vs third)?
- Vocabulary tier: matches the audience reading level — no jargon explosions, no childish slang in a clinical product?
- Sentence rhythm: variation, no monotonous walls or staccato everywhere?
- Cultural fit: idioms, units (lbs vs kg, $ vs £/€), spelling (color vs colour) match the target market?
- Emotional arc: appropriate intensity — not screaming when the topic is medical, not whispering when the offer is urgent?
- Brand-specific tics: if a brand profile defines forbidden words, banned claims, mandatory phrases — flag violations.

Quote phrasings that break voice with the EXACT competing tone label (e.g. "casual streak" / "clinical streak" / "salesy streak").
${SHARED_OUTPUT_FORMAT}`,
  },

  // Compliance handled by the dedicated /api/compliance-ai/check route,
  // not by Claude — its category-prompt is a stub that the orchestrator
  // recognises and routes to the existing endpoint.
  compliance: {
    task: 'general',
    maxTokens: 1,
    instructions: '__ROUTED_TO_COMPLIANCE_AI__',
  },

  copy: {
    task: 'vsl',
    maxTokens: 3200,
    instructions: `You are a senior direct-response copywriter auditing a multi-step sales funnel for COPY QUALITY across ALL steps provided.

For EACH step you evaluate the same fundamentals, but you give the audit weight per step's role (landing > checkout > thank-you for headline craft; checkout > all for objection handling; etc.):

- Big idea: is there ONE memorable, contrarian, ownable mechanism / promise that appears consistently across the funnel?
- Headline craft per step: specificity, curiosity, benefit-loaded, avoids "everything for everyone".
- Hook: does the opening of step 1 (and of any subsequent long-copy step) hold attention in the first 50 words?
- Mechanism strength: is the "how it works" novel, concretely explained, and reinforced — not vague — across steps?
- Framework fit: does the funnel as a whole follow a clear structure (e.g. PAS on step 1 → mechanism reveal on step 2 → offer/CTA on step 3 → upsell on step 4)? Where does the structure break?
- Specificity: numbers, names, sources, dates — vs vague filler ("many people", "studies show") — score per step.
- Sensory / emotional language: visceral verbs, internal monologue, before/after states.
- Storytelling progression: founder story, transformation story, dimensional discovery — does the narrative escalate step-by-step or repeat itself?
- Objection handling: the FAQ / guarantee on the checkout / final step addresses the REAL objections seeded by earlier steps, not strawmen.
- Step-to-step momentum: does each step's last paragraph naturally pull the reader into the next step's opening, or are there cold restarts?

When you cite an issue or evidence, prefix it with the step label (e.g. 'Step 2 hook is generic: "Are you tired of...?"'). Reference at least 2 well-known direct-response principles by name (e.g. "Halbert's market specificity", "Schwartz's awareness ladder", "Kennedy's reason-why advertising") in the suggestions.
${SHARED_OUTPUT_FORMAT}`,
  },
};

/** Build the user message for a given category. The page text/html is
 *  passed as the analyte; brand profile is optional context.
 *
 *  Single-page version — kept for backward compat. v2 callers should
 *  use buildMultiPageUserMessage so the prompt is identical between
 *  navigation / coherence / copy and the model gets the full sequence. */
export function buildUserMessage(args: {
  category: CheckpointCategory;
  funnelName: string;
  funnelUrl: string;
  pageText: string;
  brandProfile?: string;
}): string {
  const { category, funnelName, funnelUrl, pageText, brandProfile } = args;
  const sections: string[] = [];
  sections.push(`# AUDIT TARGET`);
  sections.push(`Funnel name: ${funnelName}`);
  sections.push(`Origin URL: ${funnelUrl}`);
  sections.push(`Audit category: ${category.toUpperCase()}`);
  if (brandProfile?.trim()) {
    sections.push('');
    sections.push('# BRAND PROFILE');
    sections.push(brandProfile.trim());
  }
  sections.push('');
  sections.push('# PAGE CONTENT (extracted text + structural HTML)');
  sections.push('```');
  sections.push(pageText);
  sections.push('```');
  sections.push('');
  sections.push(
    '# YOUR TASK',
    `Run the audit defined in your system prompt and return ONLY the JSON object.`,
  );
  return sections.join('\n');
}

/** Build a user message that lists ALL pages of a multi-step funnel
 *  in order, each with its URL, optional name, and audit text.
 *  Used by the navigation/coherence/copy categories in v2. */
export interface MultiPagePromptStep {
  index: number; // 1-based, for display
  url: string;
  name?: string;
  pageText: string;
  fetchError?: string | null;
}

export function buildMultiPageUserMessage(args: {
  category: CheckpointCategory;
  funnelName: string;
  steps: MultiPagePromptStep[];
  brandProfile?: string;
  perStepCharBudget?: number;
}): string {
  const { category, funnelName, steps, brandProfile } = args;
  // We split a fixed character budget across steps so a 50-step funnel
  // doesn't blow Claude's context. Default 6000 chars / step ≈ ~1.5K
  // tokens / step → 50 steps ≈ 75K tokens (still fits 200K window).
  const perStepBudget = args.perStepCharBudget ?? 6000;

  const sections: string[] = [];
  sections.push(`# AUDIT TARGET`);
  sections.push(`Funnel name: ${funnelName}`);
  sections.push(`Audit category: ${category.toUpperCase()}`);
  sections.push(`Total steps in this funnel: ${steps.length}`);
  if (brandProfile?.trim()) {
    sections.push('');
    sections.push('# BRAND PROFILE');
    sections.push(brandProfile.trim());
  }
  sections.push('');
  sections.push('# FUNNEL PAGES (ordered, step 1 = first / step N = last)');
  for (const s of steps) {
    sections.push('');
    const heading = s.name
      ? `## STEP ${s.index} — ${s.name}`
      : `## STEP ${s.index}`;
    sections.push(heading);
    sections.push(`URL: ${s.url}`);
    if (s.fetchError) {
      sections.push(
        `[FETCH-ERROR] Could not load this page: ${s.fetchError}. Treat as MISSING in your audit.`,
      );
      continue;
    }
    sections.push('');
    sections.push('```');
    const truncated =
      s.pageText.length > perStepBudget
        ? s.pageText.slice(0, perStepBudget) +
          `\n\n[... step ${s.index} truncated, ${s.pageText.length - perStepBudget} more chars omitted]`
        : s.pageText;
    sections.push(truncated);
    sections.push('```');
  }
  sections.push('');
  sections.push(
    '# YOUR TASK',
    `Run the audit defined in your system prompt across the WHOLE sequence and return ONLY the JSON object.`,
  );
  return sections.join('\n');
}

/**
 * Strip HTML to a compact, audit-friendly representation.
 * Keeps headings, paragraphs, list items, links (with href), CTAs,
 * but drops scripts, styles, svgs, base64 noise, repeated whitespace.
 * Caps at ~30k chars to fit Claude's context comfortably.
 */
export function htmlToAuditText(html: string, maxChars = 30000): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Keep CTAs visible: convert <a> and <button> to a marker line so
  // the auditor can audit copy without losing them in tag soup.
  out = out.replace(
    /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const txt = inner.replace(/<[^>]+>/g, '').trim();
      return txt ? `[CTA-LINK href="${href.slice(0, 200)}"]${txt}[/CTA]` : '';
    },
  );
  out = out.replace(
    /<button\b[^>]*>([\s\S]*?)<\/button>/gi,
    (_m, inner: string) => {
      const txt = inner.replace(/<[^>]+>/g, '').trim();
      return txt ? `[CTA-BTN]${txt}[/CTA]` : '';
    },
  );

  // Headings + paragraphs + list items get newlines so the structure
  // survives the tag stripping below.
  out = out
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, '\n\n# $2\n')
    .replace(/<\/?(p|li|tr|td|th|div|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  // Drop everything else.
  out = out
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    // collapse 3+ blank lines
    .replace(/\n{3,}/g, '\n\n')
    // collapse runs of whitespace within a line (preserve newlines)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + `\n\n[... truncated, original ${out.length} chars]`;
  }
  return out;
}

/** Robust JSON extractor: Claude sometimes prefixes with prose or
 *  wraps in ```json fences despite the prompt. Strips both. */
export function extractJsonFromReply(reply: string): unknown {
  let text = reply.trim();
  // Strip ```json ... ``` fence
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Find the first '{' and the last matching '}' as a defence net
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(text);
}
