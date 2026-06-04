-- ─────────────────────────────────────────────────────────────────────
-- Migration: funnel_steps → add flow_name column
-- ─────────────────────────────────────────────────────────────────────
-- Permette di raggruppare gli step di un progetto sotto un "Flow"
-- (es. "Flow Plastilean", "Flow Calminity"). Lo stesso progetto può
-- ospitare più flow distinti, ognuno col suo ordine di pagine.
--
-- - Colonna NULLABLE per back-compat: gli step già esistenti restano
--   senza flow_name (verranno mostrati in un gruppo "Default" / "Senza
--   Flow" nella UI).
-- - Indice composito project_id + flow_name + step_number per query
--   veloci quando il FunnelTab raggruppa per flow.
--
-- IDEMPOTENTE: usa IF NOT EXISTS, è safe ri-runnare.
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE funnel_steps
  ADD COLUMN IF NOT EXISTS flow_name TEXT NULL;

CREATE INDEX IF NOT EXISTS funnel_steps_project_flow_step_idx
  ON funnel_steps (project_id, flow_name, step_number);

COMMENT ON COLUMN funnel_steps.flow_name IS
  'Optional grouping label. Steps inside the same project but with
   different flow_name are independent ordered sequences. NULL =
   legacy step not yet bucketed into a named flow.';
