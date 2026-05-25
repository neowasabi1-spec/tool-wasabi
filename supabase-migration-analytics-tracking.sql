-- Migration: Analytics Tracking (drop-off per funnel step)
-- ============================================================================
--
-- Cosa fa:
--   1. Crea analytics_events: log append-only di tutti gli eventi (pageview,
--      quiz_answer, cta_click, step_exit, ...) emessi dal tracker (`/t.js`)
--      iniettato automaticamente nelle pagine clonate/riscritte (vedi
--      src/lib/wasabi-tracker-inject.ts).
--   2. Crea la vista v_funnel_dropoff: per ogni project_id, ordina le pagine
--      per page_type/order_index e calcola sessioni + drop-off step-by-step.
--
-- Filosofia:
--   - Nessuna tabella "sessions" separata: la sessione è IMPLICITA, è il
--     gruppo di righe con lo stesso (project_id, session_id). Più semplice,
--     più scalabile, niente lock contesi.
--   - project_id (uuid) è il "funnel id" esposto come data-funnel nel tag
--     iniettato. Niente tracking_key shortcode in v1 — risparmia una tabella
--     e una join; aggiungibile dopo se vogliamo URL più carini.
--   - page_id (uuid) opzionale: se l'evento arriva da una pagina mappata in
--     funnel_pages, lo popoliamo lato server (validato cross-checking col
--     project_id). Se manca (pagina deployata ma non più tracciata in DB,
--     dominio sconosciuto, ecc.), l'evento si tiene comunque ma resta
--     "orfano" — utile per debug.
--
-- Privacy:
--   - Niente PII. user_agent e referrer sono dati di richiesta standard.
--   - session_id è generato client-side e vive in sessionStorage (muore
--     a tab close) — non è un identificatore persistente cross-session.
--   - Niente IP storage in v1 (Postgres non lo riceve dai webhooks).
--
-- Volume previsto:
--   - 1 pageview + 1 step_exit per pagina visitata = ~2 righe/pageview.
--   - Quiz: + N righe (1 per risposta).
--   - 1000 visite/giorno × 5 step × 3 eventi medi = ~15k righe/giorno.
--   - A 5M righe pensiamo a partition mensile su created_at (TODO futuro).

-- ============================================================================
-- analytics_events
-- ============================================================================
CREATE TABLE IF NOT EXISTS analytics_events (
  id           BIGSERIAL PRIMARY KEY,

  -- Funnel identifier = project_id (uuid). Lo storiamo qui denormalizzato
  -- per query veloci senza join. Non ho messo FK formale a `projects` per
  -- non far fallire l'insert se il project viene cancellato: l'evento e'
  -- storico, deve sopravvivere alla cancellazione del progetto.
  project_id   UUID NOT NULL,

  -- Page identifier (funnel_pages.id). NULL = evento orfano (pagina non
  -- mappata o cancellata). Lo popoliamo lato server matchando l'URL della
  -- richiesta con funnel_pages quando possibile, oppure leggendolo dal
  -- data-page del tag iniettato (preferito, più affidabile).
  page_id      UUID,

  -- Session id (uuid v4) generato client-side dal tracker. NON e' un
  -- visitor id persistente: ogni nuova tab/sessione browser genera un
  -- session_id nuovo. Le sessioni cross-host viaggiano via ?wsid= nella
  -- query string.
  session_id   TEXT NOT NULL,

  -- 'pageview' | 'step_enter' | 'step_exit' | 'quiz_answer' | 'cta_click'
  -- | 'form_submit' | 'video_progress' | 'custom'
  event_type   TEXT NOT NULL,

  -- URL completa al momento dell'evento (include query string per capire
  -- da quale ads / utm_source viene la sessione).
  url          TEXT NOT NULL DEFAULT '',
  referrer     TEXT NOT NULL DEFAULT '',
  user_agent   TEXT NOT NULL DEFAULT '',

  -- Tutto il payload custom: { q: 1, a: 'pancia' } per quiz_answer,
  -- { dwell_ms: 12300 } per step_exit, ecc. Schemaless per non bloccarci.
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Best-effort bot detection client-side (navigator.webdriver, UA pattern).
  -- La vista drop-off filtra is_bot=false di default.
  is_bot       BOOLEAN NOT NULL DEFAULT FALSE,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indici critici (in ordine di importanza):

-- 1. Per la vista drop-off: count(distinct session_id) per project+page.
CREATE INDEX IF NOT EXISTS idx_analytics_events_project_page_session
  ON analytics_events(project_id, page_id, session_id)
  WHERE is_bot = FALSE;

-- 2. Per ricostruire i percorsi di una sessione (debug + segmentazione).
CREATE INDEX IF NOT EXISTS idx_analytics_events_project_session_time
  ON analytics_events(project_id, session_id, created_at);

-- 3. Per query time-window (oggi / 7d / 30d).
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
  ON analytics_events(created_at DESC);

-- 4. Per filtri per evento (es. solo quiz_answer).
CREATE INDEX IF NOT EXISTS idx_analytics_events_project_event
  ON analytics_events(project_id, event_type, created_at DESC);

-- ============================================================================
-- v_funnel_dropoff
-- ============================================================================
-- Calcola, per ogni project + page, le sessioni distinte che hanno fatto
-- almeno un 'pageview', poi confronta col passo precedente per il drop-off.
--
-- Ordinamento step: la tabella funnel_pages non ha un order_index esplicito
-- nello schema attuale (si veda supabase-schema.sql linea 71+), quindi
-- ordiniamo per:
--   1. page_type (landing -> upsell -> thankyou seguendo l'enum naturale)
--   2. created_at (fallback)
-- Quando aggiungeremo order_index esplicito, basta cambiare l'ORDER BY qui.
--
-- "loose" funnel: conta una sessione su uno step anche se ha saltato gli
-- step precedenti (es. utente che arriva direttamente al checkout da ads).
-- Per il drop-off "strict" (solo chi e' passato in ordine), aggiungere una
-- vista parallela v_funnel_dropoff_strict (TODO quando serve).

DROP VIEW IF EXISTS v_funnel_dropoff;

CREATE VIEW v_funnel_dropoff AS
WITH step_sessions AS (
  SELECT
    e.project_id,
    e.page_id,
    fp.name              AS page_name,
    fp.page_type::text   AS page_type,
    -- Ordinamento naturale del funnel: lander -> presell -> checkout -> upsell -> thank you.
    -- I valori page_type sono nell'enum, qui li mappo a un peso numerico.
    CASE fp.page_type::text
      WHEN 'lander'      THEN 10
      WHEN 'landing'     THEN 10
      WHEN 'presell'     THEN 20
      WHEN 'advertorial' THEN 20
      WHEN 'quiz'        THEN 30
      WHEN 'vsl'         THEN 40
      WHEN 'checkout'    THEN 50
      WHEN 'upsell'      THEN 60
      WHEN 'downsell'    THEN 65
      WHEN 'thank_you'   THEN 70
      WHEN 'thankyou'    THEN 70
      ELSE 99
    END AS step_order,
    fp.created_at,
    COUNT(DISTINCT e.session_id) AS sessions_count
  FROM analytics_events e
  LEFT JOIN funnel_pages fp ON fp.id = e.page_id
  WHERE e.event_type = 'pageview'
    AND e.is_bot = FALSE
    AND e.page_id IS NOT NULL
  GROUP BY e.project_id, e.page_id, fp.name, fp.page_type, fp.created_at
)
SELECT
  project_id,
  page_id,
  page_name,
  page_type,
  step_order,
  sessions_count,
  LAG(sessions_count) OVER (
    PARTITION BY project_id
    ORDER BY step_order, created_at
  ) AS previous_step_sessions,
  CASE
    WHEN LAG(sessions_count) OVER (
      PARTITION BY project_id
      ORDER BY step_order, created_at
    ) > 0
    THEN ROUND(
      (1.0 - sessions_count::numeric / LAG(sessions_count) OVER (
        PARTITION BY project_id
        ORDER BY step_order, created_at
      )) * 100,
      2
    )
    ELSE NULL
  END AS dropoff_pct,
  -- Conversion vs primo step del funnel.
  CASE
    WHEN FIRST_VALUE(sessions_count) OVER (
      PARTITION BY project_id
      ORDER BY step_order, created_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) > 0
    THEN ROUND(
      sessions_count::numeric / FIRST_VALUE(sessions_count) OVER (
        PARTITION BY project_id
        ORDER BY step_order, created_at
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      ) * 100,
      2
    )
    ELSE NULL
  END AS conversion_pct
FROM step_sessions
ORDER BY project_id, step_order, created_at;

COMMENT ON VIEW v_funnel_dropoff IS
  'Drop-off step-by-step per project_id. Una riga per pagina (page_id) con sessioni distinte, drop-off vs step precedente, conversion vs primo step. Esclude bot. Usare AnalyticsSection.tsx per visualizzare.';
