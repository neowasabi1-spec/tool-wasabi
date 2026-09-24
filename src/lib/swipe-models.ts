// Selectable Claude models for the swipe/rewrite feature.
//
// Current Claude API ids (Sept 2026). Opus 4.8 and Sonnet 4.6 reject
// a non-default `temperature` and are no longer offered in the picker.
// The UI (clone-landing + front-end-funnel) exposes them in a dropdown and
// threads the choice through to the server (/api/landing/swipe) and the
// Supabase Edge Function (funnel-swap-v1-functions), which validate the value
// against DEFAULT before use.

export interface SwipeModelOption {
  id: string;
  label: string;
  hint: string;
}

export const SWIPE_MODEL_DEFAULT = 'claude-sonnet-5';

export const SWIPE_MODEL_OPTIONS: SwipeModelOption[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: 'Veloce · consigliato · $2/$10' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'Max qualità · $4/$20' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: 'Velocissimo · economico · $1/$5' },
];

const ALLOWED = new Set(SWIPE_MODEL_OPTIONS.map((m) => m.id));

/** Return `model` when it is one of the allowed ids, otherwise the default. */
export function normalizeSwipeModel(model: unknown): string {
  return typeof model === 'string' && ALLOWED.has(model) ? model : SWIPE_MODEL_DEFAULT;
}
