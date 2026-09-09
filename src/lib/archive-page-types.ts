import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  PAGE_TYPE_OPTIONS,
  humanizePageTypeSlug,
  normalizeArchiveType,
  slugifyPageTypeLabel,
} from '@/types';

const BUILT_IN = new Set(PAGE_TYPE_OPTIONS.map((o) => o.value as string));

export function isMissingPageTypesTable(msg?: string): boolean {
  return /archive_page_types|relation .* does not exist|does not exist/i.test(msg || '');
}

export type ArchivePageType = { value: string; label: string };

export function resolvePageType(
  raw: string,
  labelHint?: string,
): { value: string; label: string; isCustom: boolean } {
  const trimmed = String(raw || '').trim().slice(0, 60);
  const hint = String(labelHint || '').trim().slice(0, 60);
  if (!trimmed && !hint) {
    return { value: 'landing', label: 'Landing Page', isCustom: false };
  }
  if (BUILT_IN.has(trimmed)) {
    const label = PAGE_TYPE_OPTIONS.find((o) => o.value === trimmed)?.label || trimmed;
    return { value: trimmed, label, isCustom: false };
  }
  const slug = slugifyPageTypeLabel(trimmed || hint);
  if (!slug) return { value: 'landing', label: 'Landing Page', isCustom: false };
  if (BUILT_IN.has(slug)) {
    const label = PAGE_TYPE_OPTIONS.find((o) => o.value === slug)?.label || slug;
    return { value: slug, label, isCustom: false };
  }
  const canonical = normalizeArchiveType(trimmed || hint);
  if (canonical !== 'altro' && BUILT_IN.has(canonical)) {
    const label = PAGE_TYPE_OPTIONS.find((o) => o.value === canonical)?.label || canonical;
    return { value: canonical, label, isCustom: false };
  }
  const label = hint || (trimmed !== slug ? trimmed : humanizePageTypeSlug(slug));
  return { value: slug, label, isCustom: true };
}

export async function listArchivePageTypes(userId: string): Promise<ArchivePageType[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('archive_page_types')
      .select('value, label')
      .eq('owner_user_id', userId)
      .order('created_at', { ascending: true });
    if (error) {
      if (!isMissingPageTypesTable(error.message)) {
        console.warn('[archive-page-types] list:', error.message);
      }
      return [];
    }
    const out: ArchivePageType[] = [];
    const seen = new Set<string>();
    for (const row of data || []) {
      const value = slugifyPageTypeLabel(String(row.value || ''));
      if (!value || BUILT_IN.has(value) || seen.has(value)) continue;
      seen.add(value);
      out.push({
        value,
        label: String(row.label || '').trim() || humanizePageTypeSlug(value),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function upsertArchivePageType(
  userId: string,
  value: string,
  label: string,
): Promise<boolean> {
  const slug = slugifyPageTypeLabel(value);
  if (!slug || BUILT_IN.has(slug)) return false;
  const name = String(label || '').trim().slice(0, 60) || humanizePageTypeSlug(slug);
  const { error } = await supabaseAdmin
    .from('archive_page_types')
    .upsert(
      { value: slug, label: name, owner_user_id: userId },
      { onConflict: 'owner_user_id,value' },
    );
  if (error) {
    if (!isMissingPageTypesTable(error.message)) {
      console.warn('[archive-page-types] upsert:', error.message);
    }
    return false;
  }
  return true;
}

export async function deleteArchivePageType(userId: string, value: string): Promise<void> {
  const slug = slugifyPageTypeLabel(value);
  if (!slug) return;
  try {
    await supabaseAdmin
      .from('archive_page_types')
      .delete()
      .eq('owner_user_id', userId)
      .eq('value', slug);
  } catch {
    /* ignore */
  }
}
