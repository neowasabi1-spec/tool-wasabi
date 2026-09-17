import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  BUILT_IN_AD_TYPE_OPTIONS,
  humanizeAdTypeSlug,
  slugifyPageTypeLabel,
} from '@/types';

const BUILT_IN = new Set(BUILT_IN_AD_TYPE_OPTIONS.map((o) => o.value));

export function isMissingAdTypesTable(msg?: string): boolean {
  return /archive_ad_types|archive_ads|relation .* does not exist|does not exist/i.test(msg || '');
}

export type ArchiveAdType = { value: string; label: string };

export function resolveAdType(
  raw: string,
  labelHint?: string,
): { value: string; label: string; isCustom: boolean } {
  const trimmed = String(raw || '').trim().slice(0, 60);
  const hint = String(labelHint || '').trim().slice(0, 60);
  if (!trimmed && !hint) {
    return { value: 'image', label: 'Image', isCustom: false };
  }
  if (BUILT_IN.has(trimmed)) {
    const label = BUILT_IN_AD_TYPE_OPTIONS.find((o) => o.value === trimmed)?.label || trimmed;
    return { value: trimmed, label, isCustom: false };
  }
  const slug = slugifyPageTypeLabel(trimmed || hint);
  if (!slug) return { value: 'image', label: 'Image', isCustom: false };
  if (BUILT_IN.has(slug)) {
    const label = BUILT_IN_AD_TYPE_OPTIONS.find((o) => o.value === slug)?.label || slug;
    return { value: slug, label, isCustom: false };
  }
  const label = hint || (trimmed !== slug ? trimmed : humanizeAdTypeSlug(slug));
  return { value: slug, label, isCustom: true };
}

export async function listArchiveAdTypes(userId: string): Promise<ArchiveAdType[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('archive_ad_types')
      .select('value, label')
      .eq('owner_user_id', userId)
      .order('created_at', { ascending: true });
    if (error) {
      if (!isMissingAdTypesTable(error.message)) {
        console.warn('[archive-ad-types] list:', error.message);
      }
      return [];
    }
    const out: ArchiveAdType[] = [];
    const seen = new Set<string>();
    for (const row of data || []) {
      const value = slugifyPageTypeLabel(String(row.value || ''));
      if (!value || BUILT_IN.has(value) || seen.has(value)) continue;
      seen.add(value);
      out.push({
        value,
        label: String(row.label || '').trim() || humanizeAdTypeSlug(value),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function upsertArchiveAdType(
  userId: string,
  value: string,
  label: string,
): Promise<boolean> {
  const slug = slugifyPageTypeLabel(value);
  if (!slug || BUILT_IN.has(slug)) return false;
  const name = String(label || '').trim().slice(0, 60) || humanizeAdTypeSlug(slug);
  const { error } = await supabaseAdmin
    .from('archive_ad_types')
    .upsert(
      { value: slug, label: name, owner_user_id: userId },
      { onConflict: 'owner_user_id,value' },
    );
  if (error) {
    if (!isMissingAdTypesTable(error.message)) {
      console.warn('[archive-ad-types] upsert:', error.message);
    }
    return false;
  }
  return true;
}

export async function deleteArchiveAdType(userId: string, value: string): Promise<void> {
  const slug = slugifyPageTypeLabel(value);
  if (!slug) return;
  try {
    await supabaseAdmin
      .from('archive_ad_types')
      .delete()
      .eq('owner_user_id', userId)
      .eq('value', slug);
  } catch {
    /* ignore */
  }
}
