// Checkpoint feature: type contracts shared between server (API routes,
// edge functions) and client (UI pages, hooks). Keep this file pure
// types — no runtime imports — so it can be imported from anywhere.

/** Tables we currently pull funnels from. */
export type CheckpointSourceTable =
  | 'funnel_pages'
  | 'post_purchase_pages'
  | 'archived_funnels';

/** Audit categories we run on each funnel. Add new ones here only. */
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

/** Status di un singolo issue dentro una categoria. */
export type CheckpointIssueSeverity = 'critical' | 'warning' | 'info';

export interface CheckpointIssue {
  /** Severity decides icon/color in UI. */
  severity: CheckpointIssueSeverity;
  /** Short label, shown bold. */
  title: string;
  /** Optional longer explanation. */
  detail?: string;
  /** Optional snippet of the offending copy. */
  evidence?: string;
}

export interface CheckpointSuggestion {
  title: string;
  detail?: string;
}

/** Result of a single category for a single run. */
export interface CheckpointCategoryResult {
  /** 0-100, or null if not scored / errored. */
  score: number | null;
  /**
   * - 'pass'    score >= 80
   * - 'warn'    50 <= score < 80
   * - 'fail'    score < 50
   * - 'error'   the analysis itself failed (network, AI error)
   * - 'skipped' deliberately not run (e.g. compliance N/A for digital)
   */
  status: 'pass' | 'warn' | 'fail' | 'error' | 'skipped';
  /** One-paragraph executive summary. */
  summary: string;
  issues: CheckpointIssue[];
  suggestions: CheckpointSuggestion[];
  /** Raw AI reply text, for debugging / "show raw" toggle. */
  rawReply?: string;
  /** Optional usage info for cost tracking. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** If status === 'error', the human-readable reason. */
  error?: string;
}

/** Map category → result, populated only for the categories that ran. */
export type CheckpointResults = Partial<
  Record<CheckpointCategory, CheckpointCategoryResult>
>;

/** Lifecycle of a single Checkpoint run row in DB. */
export type CheckpointRunStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed';

/** A single Checkpoint run = 1 row in funnel_checkpoints. */
export interface CheckpointRun {
  id: string;
  source_table: CheckpointSourceTable;
  source_id: string;
  funnel_name: string;
  funnel_url: string;
  was_swiped: boolean;
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
  project_id: string | null;
  created_at: string;
}

/**
 * Unified funnel row shown in /checkpoint list. Built by
 * src/lib/checkpoint-sources.ts merging multiple source tables into
 * one shape so the UI doesn't care which table backs each row.
 */
export interface UnifiedFunnel {
  /** Composite ID: `${source_table}:${source_id}`. Used in URLs. */
  id: string;
  source_table: CheckpointSourceTable;
  source_id: string;
  /** Display name. */
  name: string;
  /** Origin URL (the URL we cloned/swiped). */
  url: string;
  /** Has it been swiped yet? */
  was_swiped: boolean;
  /** Where the swipe stands now: 'pending' | 'in_progress' | 'completed' | 'failed' | null. */
  swipe_status: string | null;
  /**
   * Last checkpoint run status (NULL = never checkpointed).
   * Convenience for the list view.
   */
  last_checkpoint?: {
    id: string;
    status: CheckpointRunStatus;
    score_overall: number | null;
    completed_at: string | null;
    created_at: string;
  } | null;
  /** Project this funnel belongs to (if any). */
  project_id: string | null;
  /** Source row creation time, for sort/filter. */
  created_at: string;
  /** Latest update time on the source row. */
  updated_at: string;
}
