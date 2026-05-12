// Checkpoint feature: type contracts shared between server (API
// routes) and client (UI pages). Pure types — no runtime imports.
//
// Two-table design:
//   CheckpointFunnel = a funnel the user added to monitor (1 row in
//                      checkpoint_funnels).
//   CheckpointRun    = a single "Run Checkpoint" execution (1 row in
//                      funnel_checkpoints; many per funnel).

/** Audit categories. Three-step model (transitioning to a 4-step
 *  "Tech/Detail · Marketing · Visual · All Step" sheet — the keys
 *  below are kept stable so SQL columns / historical runs / OpenClaw
 *  workers don't break. Re-mapping happens via labels + the
 *  SHEET_COLUMNS config in the checkpoint detail page):
 *
 *    1. navigation — Tech/Detail audit (Macro-section 1: Technical QA
 *                    of the funnel: swipe residuals, brand & mechanism
 *                    consistency, pricing, links, etc.)
 *    2. coherence  — Visual audit (placeholder until the dedicated
 *                    Visual prompt arrives — currently still runs the
 *                    legacy "internal coherence" prompt)
 *    3. copy       — Marketing audit (Macro-section 2: 3-expert copy
 *                    QC, Sultanich · Hormozi · Georgi)
 *    4. cro        — Copy Chief audit (Copy Chief Agent v1.0 — single
 *                    senior copy chief: hook, verbatim, IF-THEN, DRE,
 *                    mechanism, Evaldo 10Q, proof, offer, narrative
 *                    coherence, Satir 6+15). Re-uses the legacy 'cro'
 *                    SQL column (score_cro) to avoid a migration.
 *
 *  Legacy categories ('tov' | 'compliance') are kept in the union so
 *  historical runs still type-check, but new runs no longer populate
 *  them. CHECKPOINT_RUN_CATEGORIES below is the source of truth for
 *  which categories the run pipeline executes.
 */
export type CheckpointCategory =
  | 'navigation'
  | 'coherence'
  | 'copy'
  | 'cro'        // re-purposed: Copy Chief audit
  | 'tov'        // legacy
  | 'compliance'; // legacy

/** Categories the audit pipeline runs for every new checkpoint.
 *  Order matters — drives the LiveStepDashboard step order. */
export const CHECKPOINT_RUN_CATEGORIES: ReadonlyArray<CheckpointCategory> = [
  'navigation',
  'coherence',
  'copy',
  'cro',
] as const;

export const CHECKPOINT_CATEGORY_LABELS: Record<CheckpointCategory, string> = {
  navigation: 'Tech/Detail',
  coherence: 'Visual',
  copy: 'Marketing',
  cro: 'Copy Chief',
  tov: 'Tone of Voice',
  compliance: 'Compliance',
};

export const CHECKPOINT_CATEGORY_DESCRIPTIONS: Record<
  CheckpointCategory,
  string
> = {
  navigation:
    'Technical QA del funnel (Macro-section 1): swipe residuals, brand & mechanism consistency (1C critico), prezzi, numeri/claims, date, links/flow, urgency. Mark NOT VERIFIED per check che richiedono browser/JS/mobile/screenshots.',
  coherence:
    'Coerenza interna across tutta la sequenza: claim vs proof, promesse vs garanzie, mechanism vs benefit, contraddizioni tra step.',
  copy:
    'Marketing audit (Macro-section 2): tre esperti in uno (Sultanich systems · Hormozi offer · Georgi RMBC). Funnel ID, narrative fit, IF-THEN, One Big Idea, Value Equation, Grand Slam Offer, Avatar DRE, mechanism depth, Evaldo 10Q, pain triplets, Satir 6 layers, social proof, LIFT.',
  cro:
    'Copy Chief audit (Copy Chief Agent v1.0): hook quality, verbatim test, IF-THEN logic, Avatar DRE, mechanism depth, Evaldo 10 questions, proof & credibility, offer copy, closing, narrative coherence cross-page, Satir 6 layers + 15-step. Verdetto APPROVED / WITH FIXES / NOT APPROVED.',
  tov:
    '(Legacy) Tone of voice rispetto al brand profile.',
  compliance:
    '(Legacy) Pass/fail su sezioni A1-E1: refund, testimonial, claims.',
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
  /** New (v2): per-step nav/flow score. */
  score_navigation: number | null;
  score_coherence: number | null;
  score_copy: number | null;
  /** Legacy columns, kept so older runs still load. */
  score_cro: number | null;
  score_tov: number | null;
  score_compliance: number | null;
  score_overall: number | null;
  results: CheckpointResults;
  status: CheckpointRunStatus;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  /** Audit log: who pressed "Run Checkpoint". null until users land. */
  triggered_by_user_id: string | null;
  /** Snapshot of the user's name at run time (kept readable even if
   *  the user is later renamed or deleted). */
  triggered_by_name: string | null;
}

/** A flattened "global log" row used by the Log modal: a run with
 *  the parent funnel's id/name attached for display. */
export interface CheckpointLogEntry {
  id: string;
  checkpoint_funnel_id: string;
  funnel_name: string;
  funnel_url: string;
  score_overall: number | null;
  status: CheckpointRunStatus;
  triggered_by_user_id: string | null;
  triggered_by_name: string | null;
  created_at: string;
  completed_at: string | null;
  /** ms between created_at and completed_at, null if still running. */
  duration_ms: number | null;
}

/** Single ordered step inside a multi-step funnel. */
export interface CheckpointFunnelPage {
  url: string;
  name?: string;
}

/** A funnel the user added to the Checkpoint library. v2: a funnel
 *  is a SEQUENCE of pages. The legacy single-`url` field is kept as
 *  a quick-display "first page" mirror of pages[0].url. */
export interface CheckpointFunnel {
  id: string;
  name: string;
  url: string;
  /** Ordered list of pages in the funnel (>= 1). New in v2. */
  pages: CheckpointFunnelPage[];
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

/** Body for POST /api/checkpoint/funnels.
 *  Either `url` (single-page) or `pages` (multi-step). If both are
 *  supplied, `pages` wins and `url` is treated as legacy noise. */
export interface CreateCheckpointFunnelInput {
  url?: string;
  /** Multi-step funnel: ordered list of pages. Min 1, max 50. */
  pages?: CheckpointFunnelPage[];
  name?: string;
  notes?: string;
  brand_profile?: string;
  product_type?: 'supplement' | 'digital' | 'both';
  project_id?: string;
}
