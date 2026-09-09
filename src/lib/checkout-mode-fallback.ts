/**
 * Persistence fallback for `funnel_pages.checkout_mode`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The proper home for the checkout flavour is the `funnel_pages.checkout_mode`
 * column added by supabase-migration-funnel-pages-checkout-mode.sql. On a
 * deploy where that migration has NOT been applied, createFunnelPage /
 * updateFunnelPage detect the missing column and retry without it — the row
 * still saves, but the choice is silently dropped and the selector snaps back
 * to "Standard" on the next render.
 *
 * When the operator has no way to run the migration (no Supabase dashboard
 * access), that makes the WasabiCRM option unusable in the funnel table even
 * though every AI path downstream is wired and working.
 *
 * So we keep a sidecar copy in the pre-existing `settings` key/value table
 * under a single JSON row. Note that on this project `key` carries NO unique
 * or primary-key constraint, so writes are select-then-update/insert rather
 * than an upsert — see writeMode():
 *
 *     key   = 'funnel_page_checkout_modes'
 *     value = {"<funnel_page_id>": "wasabi", ...}
 *
 * PRECEDENCE — the real column always wins:
 *   1. funnel_pages.checkout_mode   (once the migration is applied)
 *   2. this sidecar                 (server-side, survives reload + shared)
 *   3. localStorage                 (client-side last resort, see the store)
 *
 * That ordering means this module quietly becomes dead weight the moment the
 * migration lands — nothing needs to be unwound.
 *
 * KNOWN LIMITS (accepted trade-offs for a workaround):
 *   - One global row, not per-user. Page ids are UUIDs so entries never
 *     collide, but every tenant shares the row.
 *   - Read-modify-write, so two simultaneous writers can clobber each other.
 *     Last write wins; the blast radius is one dropdown value.
 *   - Entries for deleted pages are pruned opportunistically (see writeMode).
 */

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalizeCheckoutMode, type CheckoutMode } from '@/lib/checkout-modes';

export const CHECKOUT_MODE_SETTINGS_KEY = 'funnel_page_checkout_modes';

export type CheckoutModeMap = Record<string, CheckoutMode>;

/** Shape guard: anything that isn't a {id: 'wasabi'|'standard'} map is dropped. */
function coerceMap(raw: unknown): CheckoutModeMap {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: CheckoutModeMap = {};
  for (const [id, mode] of Object.entries(parsed as Record<string, unknown>)) {
    // Only persist the non-default. 'standard' is the absence of an entry, so
    // the map stays small and a cleared value really means cleared.
    if (normalizeCheckoutMode(mode) === 'wasabi') out[id] = 'wasabi';
  }
  return out;
}

/**
 * Every id currently marked 'wasabi'. Returns {} on any failure — a missing
 * `settings` table, RLS refusal, network error — because a broken sidecar must
 * degrade to "everything is standard", never to an error the operator sees.
 */
export async function readAllModes(): Promise<CheckoutModeMap> {
  return (await readAllModesDetailed()).modes;
}

/** Same read, but keeps the failure reason so the route can report it. */
export async function readAllModesDetailed(): Promise<{
  modes: CheckoutModeMap;
  error?: string;
}> {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('settings')
      .select('value')
      .eq('key', CHECKOUT_MODE_SETTINGS_KEY)
      .limit(1);

    if (error) {
      console.warn('[checkout-mode-fallback] read failed:', error.message);
      return { modes: {}, error: error.message };
    }
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    return { modes: coerceMap(row?.value) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[checkout-mode-fallback] read threw:', msg);
    return { modes: {}, error: msg };
  }
}

/**
 * Set (or clear) one page's flavour.
 * `knownPageIds`, when supplied, prunes entries for pages that no longer
 * exist so the row can't grow without bound.
 */
export async function writeMode(
  pageId: string,
  mode: CheckoutMode,
  knownPageIds?: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!pageId) return { ok: false, error: 'pageId required' };

  try {
    const admin = getSupabaseAdmin();
    const current = await readAllModes();

    if (normalizeCheckoutMode(mode) === 'wasabi') {
      current[pageId] = 'wasabi';
    } else {
      delete current[pageId];
    }

    if (knownPageIds && knownPageIds.length > 0) {
      const live = new Set(knownPageIds);
      // Keep the page we were just handed even if the caller's list is stale.
      live.add(pageId);
      for (const id of Object.keys(current)) {
        if (!live.has(id)) delete current[id];
      }
    }

    // Deliberately NOT an upsert with onConflict:'key'. The `settings` table
    // on this project has no unique/PK constraint on `key`, so PostgREST
    // rejects it with "there is no unique or exclusion constraint matching
    // the ON CONFLICT specification". Select-then-update/insert needs no
    // constraint and works whatever shape the table happens to be in.
    const payload = {
      key: CHECKOUT_MODE_SETTINGS_KEY,
      value: JSON.stringify(current),
      updated_at: new Date().toISOString(),
    };

    const { data: existing, error: readErr } = await admin
      .from('settings')
      .select('key')
      .eq('key', CHECKOUT_MODE_SETTINGS_KEY)
      .limit(1);

    if (readErr) {
      console.warn('[checkout-mode-fallback] pre-read failed:', readErr.message);
      return { ok: false, error: readErr.message };
    }

    const { error } = existing && existing.length > 0
      ? await admin.from('settings').update(payload).eq('key', CHECKOUT_MODE_SETTINGS_KEY)
      : await admin.from('settings').insert(payload);

    if (error) {
      // `updated_at` may not exist on every deployment's `settings` table.
      // Retry with just key+value before giving up.
      const retryPayload = { key: CHECKOUT_MODE_SETTINGS_KEY, value: payload.value };
      const retry = existing && existing.length > 0
        ? await admin.from('settings').update(retryPayload).eq('key', CHECKOUT_MODE_SETTINGS_KEY)
        : await admin.from('settings').insert(retryPayload);
      if (retry.error) {
        console.warn('[checkout-mode-fallback] write failed:', retry.error.message);
        return { ok: false, error: retry.error.message };
      }
    }

    console.log(
      `[checkout-mode-fallback] ${pageId} -> ${normalizeCheckoutMode(mode)} ` +
        `(${Object.keys(current).length} wasabi page(s) tracked)`,
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[checkout-mode-fallback] write threw:', msg);
    return { ok: false, error: msg };
  }
}

/** True when funnel_pages.checkout_mode exists — i.e. the sidecar is redundant. */
export async function columnExists(): Promise<boolean> {
  try {
    const admin = getSupabaseAdmin();
    const { error } = await admin.from('funnel_pages').select('checkout_mode').limit(1);
    return !error;
  } catch {
    return false;
  }
}
