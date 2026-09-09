/**
 * Best-effort, operator-triggered attempt to apply
 * supabase-migration-funnel-pages-checkout-mode.sql from inside the app, for
 * deploys where nobody has Supabase dashboard access.
 *
 * It leans on the `exec_sql` RPC that this project already relies on
 * elsewhere (see /api/openclaw/config). If that function doesn't exist — the
 * common case on a locked-down project — this reports the failure and the
 * sidecar in /api/checkout-mode keeps handling persistence instead.
 *
 * The statements are exactly the shipped migration: additive, idempotent, and
 * safe to run repeatedly. ADD COLUMN IF NOT EXISTS on a nullable TEXT does not
 * rewrite existing rows, and the CHECK passes trivially because every
 * pre-existing row is NULL.
 *
 * POST only — never runs implicitly on a read path.
 */

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { columnExists } from '@/lib/checkout-mode-fallback';

export const dynamic = 'force-dynamic';

const STATEMENTS = [
  `ALTER TABLE funnel_pages ADD COLUMN IF NOT EXISTS checkout_mode TEXT;`,
  `ALTER TABLE funnel_pages DROP CONSTRAINT IF EXISTS funnel_pages_checkout_mode_check;`,
  `ALTER TABLE funnel_pages ADD CONSTRAINT funnel_pages_checkout_mode_check
     CHECK (checkout_mode IS NULL OR checkout_mode IN ('standard', 'wasabi'));`,
];

export async function POST() {
  const before = await columnExists();
  if (before) {
    return NextResponse.json({
      applied: false,
      alreadyPresent: true,
      columnExists: true,
      message: 'funnel_pages.checkout_mode already exists — nothing to do.',
    });
  }

  const admin = getSupabaseAdmin();
  const attempts: { sql: string; ok: boolean; error?: string }[] = [];

  for (const sql of STATEMENTS) {
    try {
      const { error } = await admin.rpc('exec_sql', { sql });
      attempts.push({ sql: sql.trim().split('\n')[0], ok: !error, error: error?.message });
      if (error) break; // no point running the rest
    } catch (err) {
      attempts.push({
        sql: sql.trim().split('\n')[0],
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  const after = await columnExists();
  const firstError = attempts.find((a) => !a.ok)?.error;

  console.log(
    `[api/checkout-mode/migrate] exec_sql attempt -> columnExists=${after} ` +
      `(${attempts.filter((a) => a.ok).length}/${STATEMENTS.length} statements ok)`,
  );

  return NextResponse.json({
    applied: after && !before,
    columnExists: after,
    attempts,
    message: after
      ? 'Migration applied — funnel_pages.checkout_mode now exists.'
      : `Could not apply automatically (${firstError ?? 'exec_sql unavailable'}). ` +
        'The sidecar in /api/checkout-mode will persist the choice instead.',
  });
}
