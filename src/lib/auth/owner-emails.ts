import { supabaseAdmin } from '@/lib/supabase-admin';

/** Resolve auth emails for a set of user ids. Master-only list UIs. */
export async function ownerEmailById(userIds: string[]): Promise<Map<string, string>> {
  const want = new Set(userIds.filter(Boolean));
  const out = new Map<string, string>();
  if (!want.size) return out;
  const { data } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const u of data?.users || []) {
    if (want.has(u.id) && u.email) out.set(u.id, u.email);
  }
  return out;
}
