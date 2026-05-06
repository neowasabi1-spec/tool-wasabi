/**
 * Anthropic Claude wrapper with:
 *   1) Copywriting Knowledge Base injection (Tier 1 always, Tier 2 by task)
 *   2) Prompt Caching (cache_control: ephemeral) on KB blocks
 *      → first call full price, subsequent calls within ~5min pay 10% on KB
 *   3) Brief + Market Research as part of the user message (NOT cached,
 *      since they vary per project)
 *
 * Drop-in usage from any Next.js route handler:
 *
 *   import { callClaudeWithKnowledge } from '@/lib/anthropic-with-knowledge';
 *
 *   const { reply, usage } = await callClaudeWithKnowledge({
 *     task: 'vsl',
 *     instructions: 'You are an expert VSL copywriter...',
 *     brief: '...',
 *     marketResearch: '...',
 *     messages: [{ role: 'user', content: 'Write a 5-min VSL lead.' }],
 *   });
 */

import {
  getCoreKnowledge,
  getKnowledgeForTask,
  type CopywritingTask,
} from '@/knowledge/copywriting';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CallClaudeOptions {
  /** Domain task — drives Tier 2 KB injection and routing. */
  task?: CopywritingTask;
  /**
   * Persona / role-specific instructions.
   * Becomes the FIRST system block (cached together with the KB).
   */
  instructions: string;
  /** Product brief text. Becomes part of the user message. Optional. */
  brief?: string;
  /** Market research text. Becomes part of the user message. Optional. */
  marketResearch?: string;
  /** Conversation history. The last user message gets brief+research prefixed. */
  messages: ClaudeMessage[];
  /** Override model (default: Sonnet 4). */
  model?: string;
  /** Override max output tokens. */
  maxTokens?: number;
  /** API key override (otherwise process.env.ANTHROPIC_API_KEY). */
  apiKey?: string;
  /** Disable KB injection (for debugging cost-free). */
  skipKnowledge?: boolean;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface CallClaudeResult {
  reply: string;
  usage: ClaudeUsage;
  model: string;
  stopReason?: string;
}

/**
 * Builds the multi-block system prompt with cache_control on KB blocks.
 *
 * Anthropic supports up to 4 cache breakpoints. We use:
 *   block 0: instructions (persona) + Tier 1 KB  → cached together
 *   block 1: Tier 2 task-specific KB             → cached separately (when present)
 *
 * Why 2 blocks instead of 1? Because Tier 2 changes per task type. Putting
 * it in its own block means the Tier 1 cache survives across ALL tasks.
 */
function buildSystemBlocks(
  instructions: string,
  task: CopywritingTask,
  skipKnowledge: boolean,
): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  if (skipKnowledge) {
    return [{ type: 'text', text: instructions }];
  }

  const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [];

  const core = getCoreKnowledge();
  const tier1 = [instructions.trim(), core.trim()].filter(Boolean).join('\n\n---\n\n');
  blocks.push({
    type: 'text',
    text: tier1,
    cache_control: { type: 'ephemeral' },
  });

  const tier2 = getKnowledgeForTask(task).trim();
  if (tier2.length > 0) {
    blocks.push({
      type: 'text',
      text: tier2,
      cache_control: { type: 'ephemeral' },
    });
  }

  return blocks;
}

/**
 * Prepends brief + market research to the LATEST user message.
 * Conversation history is preserved untouched.
 */
function buildMessages(
  messages: ClaudeMessage[],
  brief?: string,
  marketResearch?: string,
): ClaudeMessage[] {
  if (!brief && !marketResearch) return messages;
  if (messages.length === 0) return messages;

  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];

  if (last.role !== 'user') return messages;

  const sections: string[] = [];
  if (brief?.trim()) {
    sections.push('# PRODUCT BRIEF', '', brief.trim());
  }
  if (marketResearch?.trim()) {
    sections.push('# MARKET RESEARCH', '', marketResearch.trim());
  }
  sections.push('# REQUEST', '', last.content);

  const updated: ClaudeMessage = {
    role: 'user',
    content: sections.join('\n\n'),
  };

  return [...messages.slice(0, lastIdx), updated];
}

export async function callClaudeWithKnowledge(
  opts: CallClaudeOptions,
): Promise<CallClaudeResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? 4096;
  const task = opts.task ?? 'general';

  const system = buildSystemBlocks(
    opts.instructions,
    task,
    opts.skipKnowledge ?? false,
  );
  const messages = buildMessages(opts.messages, opts.brief, opts.marketResearch);

  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${errBody}`);
  }

  const data = await response.json();
  const reply: string = data.content?.[0]?.text ?? '';
  const usage: ClaudeUsage = data.usage ?? {};
  const stopReason: string | undefined = data.stop_reason;

  return { reply, usage, model, stopReason };
}

/** For UI/debug surfaces: human-friendly cost breakdown. */
export function summarizeUsage(usage: ClaudeUsage): string {
  const parts: string[] = [];
  if (usage.input_tokens != null) parts.push(`in: ${usage.input_tokens}`);
  if (usage.cache_read_input_tokens != null && usage.cache_read_input_tokens > 0) {
    parts.push(`cached: ${usage.cache_read_input_tokens}`);
  }
  if (usage.cache_creation_input_tokens != null && usage.cache_creation_input_tokens > 0) {
    parts.push(`cache_write: ${usage.cache_creation_input_tokens}`);
  }
  if (usage.output_tokens != null) parts.push(`out: ${usage.output_tokens}`);
  return parts.join(' | ');
}
