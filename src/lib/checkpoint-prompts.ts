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
    maxTokens: 2500,
    instructions: `You are an editor checking a sales funnel page for INTERNAL COHERENCE.

You verify:
- Claim vs proof: every bold claim ("X% reduction", "4.3/5 stars", "scientifically proven") has nearby supporting evidence (study link, citation, data source).
- Promise vs guarantee: the headline promise matches what the guarantee actually covers (timeframe, scope, conditions).
- Mechanism vs benefit: when the page mentions WHY the product works, the mechanism is consistent across sections (no "EMS" in section 1 and "vibration therapy" in section 5 with no link).
- Audience consistency: the "who is this for" stays stable (no "for athletes" + "for grandmas with arthritis" without a unifying frame).
- Pricing/offer consistency: the price, bonuses, and shipping claims match across CTAs, sticky bars, and FAQ.
- Tone consistency: no clinical "GLP-1 receptor agonist" paragraphs next to "OMG you have to try this!".

Quote contradictions verbatim — show the two clashing snippets in the issues.
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
    maxTokens: 2800,
    instructions: `You are a senior direct-response copywriter auditing a sales funnel page for COPY QUALITY.

You evaluate:
- Big idea: is there ONE memorable, contrarian, ownable mechanism / promise? Or just generic claims?
- Headline craft: specificity, curiosity, benefit-loaded, avoids "everything for everyone"?
- Hook: does the opening hold attention in the first 50 words?
- Mechanism strength: is the "how it works" novel and concretely explained, or vague hand-waving?
- Framework fit: does the page follow a clear structure (PAS / AIDA / 4Ps / 5-stage)? Where does it break?
- Specificity: numbers, names, sources, dates — vs vague filler ("many people", "studies show")?
- Sensory / emotional language: visceral verbs, internal monologue, before/after states?
- Storytelling: founder story, transformation story, dimensional discovery — present and well-paced?
- Objection handling: the FAQ / guarantee section addresses the REAL objections, not strawmen?

You must reference at least 2 well-known direct-response principles by name (e.g. "Halbert's market specificity", "Schwartz's awareness ladder", "Kennedy's reason-why advertising") in the suggestions.
${SHARED_OUTPUT_FORMAT}`,
  },
};

/** Build the user message for a given category. The page text/html is
 *  passed as the analyte; brand profile is optional context. */
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
