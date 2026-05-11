// Checkpoint feature: type contracts shared between server (API
// routes) and client (UI pages). Pure types — no runtime imports.
//
// Two-table design:
//   CheckpointFunnel = a funnel the user added to monitor (1 row in
//                      checkpoint_funnels).
//   CheckpointRun    = a single "Run Checkpoint" execution (1 row in
//                      funnel_checkpoints; many per funnel).

/** Audit categories. Add new ones here only. */
export type CheckpointCategory =
  | 'cro'
  | 'coherence'
  | 'tov'
  | 'compliance'
  | 'copy';

export const CHECKPOINT_CATEGORY_LABELS: Record<CheckpointCategory, string> = {
  cro: 'CRO',
  coherence: 'Coerenza',
  tov: 'Tone of Voice',
  compliance: 'Compliance',
  copy: 'Copy Quality',
};

export const CHECKPOINT_CATEGORY_DESCRIPTIONS: Record<
  CheckpointCategory,
  string
> = {
  cro:
    'CTA chiarezza, value prop above-the-fold, urgency, social proof, friction, gerarchia visiva.',
  coherence:
    'Coerenza interna: claim vs proof, promesse vs garanzie, mechanism vs benefit, contraddizioni.',
  tov:
    'Tone of voice rispetto al brand profile (o competitor di riferimento se brand assente).',
  compliance:
    'Pass/fail su sezioni A1-E1: refund, scarcity onesta, testimonial, claims, footer legale.',
  copy:
    'Qualità della copy: framework (PAS/AIDA), big idea, mechanism strength, hook, headline.',
};

/** Per-issue severity. */
export type CheckpointIssueSeverity = 'critical' | 'warning' | 'info';

export interface CheckpointIssue {
  severity: CheckpointIssueSeverity;
  title: string;
  detail?: string;
  /** Verbatim copy snippet. */
  evidence?: string;
}

export interface CheckpointSuggestion {
  title: string;
  detail?: string;
}

export interface CheckpointCategoryResult {
  /** 0-100, or null if not scored / errored. */
  score: number | null;
  /**
   * - 'pass'    score >= 80
   * - 'warn'    50 <= score < 80
   * - 'fail'    score < 50
   * - 'error'   the analysis itself failed
   * - 'skipped' deliberately not run
   */
  status: 'pass' | 'warn' | 'fail' | 'error' | 'skipped';
  summary: string;
  issues: CheckpointIssue[];
  suggestions: CheckpointSuggestion[];
  /** Raw AI reply for "show raw" debug toggle. */
  rawReply?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Human-readable error reason when status === 'error'. */
  error?: string;
}

export type CheckpointResults = Partial<
  Record<CheckpointCategory, CheckpointCategoryResult>
>;

export type CheckpointRunStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed';

/** A single run row in funnel_checkpoints. */
export interface CheckpointRun {
  id: string;
  checkpoint_funnel_id: string;
  funnel_name: string;
  funnel_url: string;
  score_cro: number | null;
  score_coherence: number | null;
  score_tov: number | null;
  score_compliance: number | null;
  score_copy: number | null;
  score_overall: number | null;
  results: CheckpointResults;
  status: CheckpointRunStatus;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

/** A funnel the user added to the Checkpoint library. */
export interface CheckpointFunnel {
  id: string;
  name: string;
  url: string;
  notes: string | null;
  brand_profile: string | null;
  product_type: 'supplement' | 'digital' | 'both';
  project_id: string | null;
  /** Denormalised "last run" snapshot. */
  last_run_id: string | null;
  last_score_overall: number | null;
  last_run_status: CheckpointRunStatus | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Body for POST /api/checkpoint/funnels. */
export interface CreateCheckpointFunnelInput {
  url: string;
  name?: string;
  notes?: string;
  brand_profile?: string;
  product_type?: 'supplement' | 'digital' | 'both';
  project_id?: string;
}
