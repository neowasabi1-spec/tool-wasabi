/**
 * Wasabi Tracker — auto-inject del tag <script> di tracking nelle pagine
 * clonate/riscritte salvate su Supabase Storage.
 *
 * Filosofia (vedi chat di design del sistema analytics):
 *   - UN solo entry point: questa funzione viene chiamata da
 *     `persistHtmlToStorage` (src/lib/funnel-html-storage.ts), che a sua
 *     volta e' l'UNICO punto attraverso cui passa l'HTML salvato. Quindi
 *     chiunque generi HTML (landing/clone, quiz-rewrite/finalize,
 *     clone-funnel, ai-edit-html, swipe-quiz/generate, edit manuale del
 *     VisualHtmlEditor, ecc.) si ritrova il tag senza saperlo.
 *
 *   - Idempotenza: prima di iniettare controlliamo `data-wasabi-tracker=`
 *     nell'HTML. Se gia' presente:
 *       a) stessa versione (`TRACKER_VERSION` invariato) → no-op
 *       b) versione diversa → rimuoviamo il vecchio tag e inseriamo il nuovo
 *     Questo permette migrazioni del tracker (cambio dominio, cambio API)
 *     bumpando TRACKER_VERSION e ri-salvando le pagine — niente migration
 *     batch obbligatoria.
 *
 *   - Fail-safe: se mancano funnelId o WASABI_TRACKER_BASE_URL ritorniamo
 *     l'HTML invariato. Niente errori bloccanti per il save — il tracking
 *     e' un'aggiunta, non deve mai impedire all'utente di salvare.
 */

/** Versione del tracker — bumpa per forzare la re-injection delle pagine
 *  esistenti al loro prossimo save. */
export const TRACKER_VERSION = '1';

/** Base URL pubblico dell'app Wasabi (dove serviamo `/t.js` e
 *  `/api/track/event`). Letta da NEXT_PUBLIC_APP_URL o VERCEL_URL.
 *  Su client il path relativo non basta: l'HTML iniettato gira su domini
 *  esterni (Replit/Lovable/CC/Funnelish) e deve risolvere assoluto. */
function getWasabiBaseUrl(): string | null {
  const explicit =
    (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_APP_URL) ||
    '';
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercel =
    typeof process !== 'undefined' && process.env?.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : '';
  if (vercel) return vercel;
  return null;
}

export type TrackerStepType =
  | 'landing'
  | 'lander'
  | 'presell'
  | 'advertorial'
  | 'quiz'
  | 'vsl'
  | 'checkout'
  | 'upsell'
  | 'downsell'
  | 'thank_you'
  | 'thankyou';

export interface InjectTrackerOptions {
  /** project_id del funnel — diventa `data-funnel` nel tag. Obbligatorio:
   *  se manca, l'inject viene saltato. */
  funnelId?: string | null;
  /** funnel_pages.id — diventa `data-page` nel tag. Permette al server di
   *  attribuire l'evento allo step preciso senza dover matchare URL. */
  pageId?: string | null;
  /** Tipo dello step (PageType). Se non passato, prova auto-detect da HTML.
   *  Solo per UI/etichette in dashboard — non usato per il calcolo
   *  drop-off (che usa page_id). */
  stepType?: TrackerStepType | string | null;
  /** Override per i test: forza il base URL invece di leggerlo da env. */
  baseUrlOverride?: string;
}

/** Marker idempotency: si scrive nel tag iniettato. Una pagina con questo
 *  attributo e versione uguale a TRACKER_VERSION viene lasciata stare. */
const TRACKER_MARKER_ATTR = 'data-wasabi-tracker';

/** Regex per rimuovere un tag tracker esistente (qualunque versione). Usata
 *  quando serve sostituirlo con uno nuovo. Multi-line + case-insensitive.
 *  Match conservativo: solo <script ... data-wasabi-tracker="..."> ...
 *  </script>. */
const EXISTING_TAG_RE =
  /<script\b[^>]*\sdata-wasabi-tracker=(["'])[^"']*\1[^>]*>[\s\S]*?<\/script>\s*/gi;

/** Estrae la versione del tag tracker gia' presente. Ritorna null se non
 *  trova un tag o se l'attributo `data-wasabi-tracker` e' vuoto/non
 *  parsabile. */
function getExistingTrackerVersion(html: string): string | null {
  const m = html.match(
    /<script\b[^>]*\sdata-wasabi-tracker=(["'])([^"']*)\1[^>]*><\/script>/i,
  );
  if (!m) return null;
  return m[2] || '';
}

/** Best-effort auto-detect del tipo di step dal contenuto HTML.
 *  Usato come fallback quando il chiamante non passa stepType esplicito.
 *  Pattern volutamente conservativi — meglio "landing" generico che un
 *  match sbagliato. */
export function detectStepType(html: string): TrackerStepType {
  const h = html.toLowerCase();

  // Thank you pages: pattern espliciti su titolo/h1/url
  if (
    /thank\s*you|thank-you|thankyou|order\s*confirm|grazie\s+per|conferma\s+ordine/i.test(
      html,
    )
  ) {
    return 'thank_you';
  }

  // Checkout: form di pagamento, riferimenti a CVV/card/checkout
  if (
    /name=["']cardnumber["']|cvv|card[_-]?number|stripe|braintree|paypal|class=["'][^"']*checkout[^"']*["']/i.test(
      html,
    )
  ) {
    return 'checkout';
  }

  // Quiz: domande/risposte strutturate
  if (
    /class=["'][^"']*quiz[^"']*["']|data-question|data-q=|quiz-option/i.test(
      html,
    )
  ) {
    return 'quiz';
  }

  // VSL: video player + minimal content (heuristic debole)
  if (
    /class=["'][^"']*vsl[^"']*["']|wistia_embed|vidyard-player|jwplayer\(/i.test(
      html,
    )
  ) {
    return 'vsl';
  }

  // Upsell/Downsell: pattern testuali specifici della categoria
  if (
    /one[\s-]?time\s+offer|upgrade\s+your\s+order|special\s+offer\s+for\s+you|aggiungi\s+al\s+tuo\s+ordine/i.test(
      h,
    )
  ) {
    return 'upsell';
  }

  return 'landing';
}

/** Costruisce il tag <script> da iniettare. */
function buildTag(opts: {
  baseUrl: string;
  funnelId: string;
  pageId?: string;
  stepType?: string;
}): string {
  const parts: string[] = [
    `<script src="${escapeAttr(opts.baseUrl)}/t.js?v=${TRACKER_VERSION}"`,
    `${TRACKER_MARKER_ATTR}="${TRACKER_VERSION}"`,
    `data-funnel="${escapeAttr(opts.funnelId)}"`,
  ];
  if (opts.pageId) parts.push(`data-page="${escapeAttr(opts.pageId)}"`);
  if (opts.stepType) parts.push(`data-step="${escapeAttr(opts.stepType)}"`);
  parts.push('defer></script>');
  return parts.join(' ');
}

function escapeAttr(v: string): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Inietta (o aggiorna) il tag tracker nell'HTML.
 *
 * - Se il tag e' gia' presente con la stessa TRACKER_VERSION → no-op.
 * - Se il tag e' presente ma con versione diversa → rimosso e re-iniettato.
 * - Se non c'e' → iniettato prima di `</head>` (preferito), o
 *   `</body>` (fallback), o appeso in coda (last resort).
 * - Se mancano funnelId o baseUrl → HTML invariato (fail-safe).
 *
 * Pure function: nessun side effect, niente fetch, niente env reads se
 * passi `baseUrlOverride`. Sicuro da chiamare in hot path.
 */
export function injectWasabiTracker(
  html: string,
  opts: InjectTrackerOptions,
): string {
  if (!html || typeof html !== 'string') return html;
  if (!opts.funnelId) return html;

  const baseUrl = opts.baseUrlOverride ?? getWasabiBaseUrl();
  if (!baseUrl) return html;

  // Idempotency
  const existingVersion = getExistingTrackerVersion(html);
  if (existingVersion === TRACKER_VERSION) {
    return html;
  }

  // Rimuovi il vecchio tag (qualunque versione) se presente
  let working = html;
  if (existingVersion !== null) {
    working = working.replace(EXISTING_TAG_RE, '');
  }

  const stepType =
    (opts.stepType && String(opts.stepType)) ||
    detectStepType(working);

  const tag = buildTag({
    baseUrl,
    funnelId: opts.funnelId,
    pageId: opts.pageId || undefined,
    stepType,
  });

  // Inserisci preferendo </head>; se non c'e' prova </body>; ultimo
  // appende in coda. Non rompe le pagine senza struttura standard
  // (es. frammenti HTML).
  if (/<\/head\s*>/i.test(working)) {
    return working.replace(/<\/head\s*>/i, `  ${tag}\n</head>`);
  }
  if (/<\/body\s*>/i.test(working)) {
    return working.replace(/<\/body\s*>/i, `  ${tag}\n</body>`);
  }
  return `${working}\n${tag}\n`;
}

/** Helper esposto per test / retrofit script: rimuove ogni tag tracker
 *  dall'HTML. Utile per pulire pagine quando si vuole ri-iniettare con
 *  parametri diversi. */
export function stripWasabiTracker(html: string): string {
  if (!html) return html;
  return html.replace(EXISTING_TAG_RE, '');
}
