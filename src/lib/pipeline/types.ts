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
  | 'angle'
  | 'ads'
  | 'landing'
  | 'swipe';

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
    label: 'Market research',
    description: 'RMBC deep research: awareness/sophistication, avatar, competitors, mechanism, angles.',
  },
  {
    key: 'brief',
    label: 'Product brief',
    description: 'Strategic brief (Ecom Domination framework) built on the research.',
  },
  {
    key: 'competitor',
    label: 'Competitor research',
    description: 'Auto keyword search across Meta, TikTok & Google ad libraries (Apify). Saves creatives per advertiser + their landings.',
  },
  {
    key: 'angle',
    label: 'Angle strategy',
    description: 'Prioritized Angle Matrix (English) from research + brief + real competitor ads: awareness, sophistication move, mechanism, competitor gap.',
  },
  {
    key: 'ads',
    label: 'Ads (Meta / TikTok / Google)',
    description: 'For the top 3 angles: 3 platform-ready ads each (Meta, TikTok/UGC, Google RSA) in the market language, saved to Creative + Funnel.',
  },
  {
    key: 'landing',
    label: 'Landing + mockup',
    description:
      'Landing copy. Internal invents a product mockup unless you uploaded a photo; Affiliate skips the mockup.',
  },
  {
    key: 'swipe',
    label: 'Funnel swipe (Clone/Swipe)',
    description:
      'Loads the selected funnel steps into Clone/Swipe, rewrites texts, restyles the palette, and regenerates every photo for our product (Internal) or places competitor landing media as-is (Affiliate).',
  },
];

export interface PipelineInput {
  /** Product name — used to match/create the project. */
  product: string;
  /** Optional competitor URL (landing or Meta Ad Library link). */
  competitorLink?: string;
  /** Optional free-form product description / notes. */
  description?: string;
  /** Target market / geography (e.g. "Germany", "US market"). Drives the
   *  geography of the research (audience, competitors, prices, regulation).
   *  Output is always written in English (a strategy doc for the team);
   *  localization into the market's local language happens later at
   *  ad/landing production. When empty, it's inferred from the description. */
  market?: string;
  /** Legacy alias for `market` — kept for back-compat. */
  language?: string;
  /** Optional funnel template URL (chosen in the launcher) used as design +
   *  copy reference when generating the landing mockup. */
  templateUrl?: string;
  /** Optional saved funnel id (archived_funnels). The final step reads its
   *  steps to derive how many products to generate (1 main + one per upsell/
   *  downsell page) — the count is read from the funnel, never guessed. */
  funnelId?: string;
  /** 0-based indexes of the steps the user ticked. Empty / omitted = all. */
  funnelStepIndexes?: number[];
  /** Snapshot of the ticked steps (walk-merged funnels included). When
   *  present, product count + swipe use this list, not the raw DB row. */
  funnelSteps?: Array<{
    index: number;
    name: string;
    pageType: string;
    isUpsell?: boolean;
    url?: string;
    pageId?: string;
    htmlUrl?: string;
  }>;
  /**
   * How Chimera puts Competitor Library → Image landings into the
   * selected template funnel:
   *   affiliate — same files, unchanged
   *   internal  — swipe those assets onto this project's product
   */
  imageMode?: 'affiliate' | 'internal';
  /** Public URL of a user-uploaded packshot. When set, skip inventing one. */
  productImageUrl?: string;
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
