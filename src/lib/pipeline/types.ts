// Shared types + step configuration for the Project Autopilot pipeline.
//
// Design principle: the pipeline state lives in Supabase (pipeline_jobs +
// the project's own section columns/tables), NOT inside a single LLM
// conversation. Each step reads the outputs of the previous steps from the
// DB and writes its own output back — so quality stays constant and the run
// is resumable, instead of degrading as one long chat context grows.

export type StepKey =
  | 'market_research'
  | 'brief'
  | 'competitor'
  | 'ads'
  | 'landing';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';

export interface PipelineStepDef {
  key: StepKey;
  label: string;
  /** Short human description shown in the UI. */
  description: string;
}

/** Canonical, ordered list of pipeline steps. The background function runs
 *  them in exactly this order. Keep in sync with the hardcoded order inside
 *  netlify/functions/pipeline-run-background.mts. */
export const PIPELINE_STEPS: PipelineStepDef[] = [
  {
    key: 'market_research',
    label: 'Ricerca mercato',
    description: 'Avatar, dolori, desideri, livello di consapevolezza e sofisticazione.',
  },
  {
    key: 'brief',
    label: 'Brief prodotto',
    description: 'Brief strategico (framework Ecom Domination) basato sulla ricerca.',
  },
  {
    key: 'competitor',
    label: 'Ricerca competitor',
    description: 'Cerca le ads su Facebook Ad Library (Apify) e le salva nella Competitor Library.',
  },
  {
    key: 'ads',
    label: 'Angoli & Ads',
    description: 'Concept pubblicitari (visibili come step nel Funnel) da brief + competitor.',
  },
  {
    key: 'landing',
    label: 'Landing + mockup',
    description: 'Copy della landing + mockup HTML visibile nella tab Funnel.',
  },
];

export interface PipelineInput {
  /** Product name — used to match/create the project. */
  product: string;
  /** Optional competitor URL (landing or Meta Ad Library link). */
  competitorLink?: string;
  /** Optional free-form product description / notes. */
  description?: string;
  /** Target market / language (e.g. "Germania", "tedesco", "US market").
   *  Drives the language of ALL outputs and the geography of the research.
   *  When empty, the pipeline infers it from the description, else defaults
   *  to Italian / Italy. */
  market?: string;
  /** Legacy alias for `market` — kept for back-compat. */
  language?: string;
  /** Optional funnel template URL (chosen in the launcher) used as design +
   *  copy reference when generating the landing mockup. */
  templateUrl?: string;
}

export interface PipelineStepState {
  key: StepKey;
  label: string;
  status: StepStatus;
  /** Short one-line summary of what was produced. */
  summary?: string;
  /** Full text output (truncated) so the UI can show it inline. */
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface PipelineJob {
  id: string;
  project_id: string | null;
  owner_user_id: string | null;
  status: JobStatus;
  input: PipelineInput;
  steps: PipelineStepState[];
  current_step: StepKey | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Build the initial steps array (all pending) for a new job. */
export function buildInitialSteps(): PipelineStepState[] {
  return PIPELINE_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    status: 'pending' as StepStatus,
  }));
}

/** Cap for the inline `output` we store in the job row so the JSONB stays
 *  small. The full artifact always lives in the project's own columns. */
export const STEP_OUTPUT_PREVIEW_CHARS = 8000;
