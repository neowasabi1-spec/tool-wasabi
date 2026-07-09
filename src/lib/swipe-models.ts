// Selectable Claude models for the swipe/rewrite feature.
//
// These ids are the ones already present in the cost table in
// openclaw-worker.js, so they are known-valid against the Anthropic API.
// The UI (clone-landing + front-end-funnel) exposes them in a dropdown and
// threads the choice through to the server (/api/landing/swipe) and the
// Supabase Edge Function (funnel-swap-v1-functions), which validate the value
// against DEFAULT before use.

export interface SwipeModelOption {
  id: string;
  label: string;
  hint: string;
}

export const SWIPE_MODEL_DEFAULT = 'claude-opus-4-8';

export const SWIPE_MODEL_OPTIONS: SwipeModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', hint: 'Max qualità · lento · $15/$75' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', hint: 'Veloce · consigliato · $3/$15' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: 'Velocissimo · economico · $0.80/$4' },
];

const ALLOWED = new Set(SWIPE_MODEL_OPTIONS.map((m) => m.id));

/** Return `model` when it is one of the allowed ids, otherwise the default. */
export function normalizeSwipeModel(model: unknown): string {
  return typeof model === 'string' && ALLOWED.has(model) ? model : SWIPE_MODEL_DEFAULT;
}
