-- Migration: add `page_blueprint` free-text column to cloning_jobs.
--
-- The Claude rewrite path now runs a "blueprint pass" once per job: before
-- rewriting the individual text blocks, the model reads the brief / market
-- research / product context + the page outline and produces the PAGE
-- STRATEGY (big idea, unique mechanism, lead, awareness, persuasive arc,
-- proof/objection order, tone). That strategy is then injected as a "north
-- star" into every batch's system prompt, so Claude rewrites coherent blocks
-- of ONE page instead of 12 disconnected texts at a time — the difference
-- between generic copy and copy written by a real copywriter.
--
-- The blueprint is generated on batch 0 and stored here so the subsequent
-- batches (separate stateless function invocations) can read it back without
-- regenerating it.
--
-- The column is nullable + defaults to NULL so existing rows don't need a
-- backfill. The edge function degrades gracefully if this column is absent:
-- it logs a warning and proceeds WITHOUT a blueprint (identical to the old
-- behaviour), so deploying the function before running this migration does
-- not break anything.

ALTER TABLE cloning_jobs
  ADD COLUMN IF NOT EXISTS page_blueprint TEXT NULL;
