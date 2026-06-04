# Multi-Tenancy — Rollout Guide

Per-user data isolation. The master account (you) sees and edits **everything**; regular users see and edit **only their own** projects, steps, products, archives, jobs, etc.

## Branch

This work lives on the `feature/multi-tenancy` branch, **not** on `main`. You can deploy a Netlify preview from this branch and test before merging.

## Files changed

### SQL migrations (run manually in Supabase Studio → SQL Editor)

1. `supabase-migration-multi-tenancy.sql` — **phase 1**.
   - Adds `owner_user_id UUID` to ~24 user-content tables.
   - Backfills existing rows to the master account.
   - Adds a `BEFORE INSERT` trigger that auto-populates `owner_user_id` from `auth.uid()` (or master as fallback).
   - Enables RLS with policies that allow: **owner**, **master**, AND a temporary `auth.uid() IS NULL` fallback so server-side anon callers keep working.
   - **Non-breaking**: safe to apply immediately.

2. `supabase-migration-multi-tenancy-phase2-tighten-rls.sql` — **phase 2**.
   - Drops the `auth.uid() IS NULL` fallback.
   - After this runs, unauthenticated server calls are **denied** by RLS.
   - **Only run AFTER all server routes have been migrated** to either attach the user JWT or use `supabaseAdmin` with explicit `owner_user_id`.

### Server helpers

- `src/lib/auth/server-guard.ts` — already existed (`requireAuth`, `requireMaster`). Unchanged.
- `src/lib/auth/get-current-user.ts` — **new**. Best-effort, non-throwing extraction of the caller's `user_id` and `isMaster` flag. Used by routes that want to filter/tag without forcing auth.

### Patched API routes (apply user-aware logic)

| Route | Behaviour change |
|-------|------------------|
| `GET /api/projecthub/projects` | Regular users see only own projects; master sees all. |
| `POST /api/projecthub/projects` | Sets `owner_user_id` on insert. |
| `GET /api/projecthub/projects/[id]` | 404 if not owner / not master. |
| `PATCH /api/projecthub/projects/[id]` | Pre-write ownership check. |
| `DELETE /api/projecthub/projects/[id]` | Pre-write ownership check. |
| `GET /api/projecthub/projects/[id]/funnel-steps` | Project ownership gate. |
| `POST /api/projecthub/projects/[id]/funnel-steps` | Project ownership gate; tags each step with `owner_user_id`. |
| `PATCH /api/projecthub/projects/[id]/funnel-steps/[stepId]` | Project ownership gate. Also **fixes pre-existing bug**: `flow_name` was missing from the writable whitelist so flow rename was silently dropped. |
| `DELETE /api/projecthub/projects/[id]/funnel-steps/[stepId]` | Project ownership gate. |
| `GET /api/projecthub/projects/[id]/files` | Project ownership gate. |
| `POST /api/projecthub/projects/[id]/files` | Project ownership gate; tags each uploaded `project_files` row with `owner_user_id`. |
| `POST /api/openclaw/queue` | Tags the new job row with `owner_user_id`. |
| `POST /api/openclaw/chat` | Tags the new job row with `owner_user_id`. |
| `POST /api/funnel-html` | Tags page_html row with `owner_user_id`. |
| `GET /api/projects/list` | Regular users see only own projects; master sees all. |

### Client cleanup

- `src/components/Sidebar.tsx` — logout now **hard-reloads** to `/login` after wiping:
  - `wasabi_session`
  - all `sb-*` / `supabase.*` / `wasabi*` keys in `localStorage`
  - `sessionStorage`

  This prevents one user's cached data from leaking into another user's session on the same browser.

### NOT patched (intentional, low-risk)

These call paths rely on the DB trigger to auto-tag `owner_user_id` and on RLS (once phase 2 lands) to enforce isolation. No code change required for phase 1:

- `src/lib/supabase-operations.ts` — all CRUD helpers. Called from the browser anon client, which carries the user JWT → trigger sets `owner_user_id = auth.uid()` automatically. Once phase 2 RLS lands, SELECTs auto-filter via RLS too.
- `/api/v1/*` routes (API-key auth) — no user context. Inserts fall back to master via the trigger. Safe default.
- `/api/mcp/*`, `/api/openclaw/action`, `/api/checkpoint/*`, `/api/clone-funnel`, `/api/quiz-archive`, `/api/swipe-quiz/*`, `/api/valchiria/*`, `/api/branding/generate`, `/api/funnel-brief/save`, `/api/funnel-analyzer/*` — same: master fallback via trigger. Will need patches when phase 2 tightens RLS if these need user attribution.
- OpenClaw workers (`openclaw-worker.js` etc.) — use service-role, bypass RLS. UPDATEs preserve `owner_user_id` from the original INSERT.

## Apply order

### Step 1 — Apply phase-1 SQL (do this first)

In Supabase Studio → SQL Editor, paste and run `supabase-migration-multi-tenancy.sql`. It is idempotent — safe to re-run.

After it succeeds, check:
- All listed tables have `owner_user_id` column.
- All existing rows have `owner_user_id` set (no nulls).
- RLS is enabled on each table.

### Step 2 — Deploy this branch

```bash
git push origin feature/multi-tenancy
```

Netlify should build a preview. Verify on the preview that:
- You (master) still see all projects, can create/edit/delete normally.
- Open a project, save funnel steps, rewrite in front-end-funnel — everything works as before.

### Step 3 — Create a test user and try isolation

Use `/admin/users` to invite a second user. Log in as that user in a different browser / private window. Verify:
- They see an EMPTY projects list (no leaks from the master).
- They can create a new project. It appears in their list, NOT in the master's list (wait, actually MASTER sees it — that's the design).
- Master sees BOTH their own projects AND the new user's project.

### Step 4 — Optional: apply phase-2 SQL to lock down further

Once everything is verified, run `supabase-migration-multi-tenancy-phase2-tighten-rls.sql` in Supabase Studio. This removes the temporary `auth.uid() IS NULL` fallback.

⚠️ **Before applying phase 2**, audit any remaining route that uses `import { supabase } from '@/lib/supabase'` server-side. If it doesn't have a user JWT (cron, worker, MCP, etc.), it will start getting empty results / write failures after phase 2.

## Rollback

```sql
-- Per table (repeat for each):
ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "<t>_owner_or_master_select" ON <t>;
DROP POLICY IF EXISTS "<t>_owner_or_master_insert" ON <t>;
DROP POLICY IF EXISTS "<t>_owner_or_master_update" ON <t>;
DROP POLICY IF EXISTS "<t>_owner_or_master_delete" ON <t>;
DROP TRIGGER IF EXISTS trg_<t>_auto_owner ON <t>;
ALTER TABLE <t> DROP COLUMN IF EXISTS owner_user_id;
```

For code: just check out `main` and redeploy.
