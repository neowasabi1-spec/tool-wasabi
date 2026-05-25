/**
 * /api/track/event — endpoint pubblico per il Wasabi tracker.
 *
 * Riceve eventi (pageview, step_exit, quiz_answer, cta_click, ...) dal
 * `public/t.js` iniettato nelle pagine clonate/riscritte. Scrive su
 * `analytics_events` via service role (bypass RLS — la tabella e' write-
 * only dall'esterno, lettura solo per la dashboard Wasabi).
 *
 * Design choices critiche:
 *
 *   1. CORS aperto a `*`: le pagine deployate girano su domini esterni
 *      (Replit/Lovable/CC/Funnelish) che non possiamo predirre tutti.
 *      Mitigazione: l'endpoint e' insert-only, non legge mai dati, non
 *      espone PII.
 *
 *   2. Niente auth: il tracker e' iniettato in HTML pubblico, qualunque
 *      auth secret finirebbe nel sorgente. Affidiamo l'integrita' al
 *      controllo lato server (project_id deve esistere) e al filtro
 *      bot lato client.
 *
 *   3. Content-Type "text/plain" supportato: il tracker spedisce il body
 *      con `Content-Type: text/plain` per evitare il preflight OPTIONS
 *      (latency saving su sendBeacon). Parsiamo manualmente.
 *
 *   4. Fail-soft: errori di insert NON ritornano 500 — silenziamo il log
 *      e rispondiamo 204. Il tracker e' fire-and-forget, un 500 farebbe
 *      retry inutili e farebbe rumore in console nel browser dell'utente
 *      finale (che e' un cliente del cliente, non un dev).
 *
 *   5. Niente rate limiting in v1: aspettiamo di vedere il traffico reale.
 *      Quando arriva, aggiungiamo un middleware con Upstash/Vercel KV.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

/** Tipi di evento accettati. Tutto il resto viene rifiutato per evitare
 *  che client compromessi inquinino la tabella con event_type arbitrari. */
const ALLOWED_EVENT_TYPES = new Set([
  'pageview',
  'step_enter',
  'step_exit',
  'quiz_answer',
  'cta_click',
  'form_submit',
  'video_progress',
  'custom',
]);

const MAX_FIELD_LENGTH = 2048;
const MAX_PAYLOAD_BYTES = 8 * 1024;

interface TrackEventBody {
  funnel_id?: string;
  page_id?: string | null;
  session_id?: string;
  event_type?: string;
  url?: string;
  referrer?: string;
  payload?: Record<string, unknown>;
  is_bot?: boolean;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function isUuid(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

function trunc(v: unknown, n = MAX_FIELD_LENGTH): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  return s.length > n ? s.slice(0, n) : s;
}

export async function OPTIONS() {
  // Preflight non strettamente necessario (usiamo text/plain) ma rispondiamo
  // comunque per i casi edge in cui il browser decida di farlo lo stesso.
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: NextRequest) {
  let body: TrackEventBody;
  try {
    // Il tracker spedisce con Content-Type: text/plain per evitare preflight.
    // Parsing manuale, niente await request.json() (che si aspetta
    // application/json e potrebbe fallire silenziosamente).
    const raw = await request.text();
    if (!raw || raw.length > MAX_PAYLOAD_BYTES) {
      return new NextResponse(null, { status: 204, headers: corsHeaders() });
    }
    body = JSON.parse(raw) as TrackEventBody;
  } catch {
    // Body non parsabile: rispondiamo 204 lo stesso (fail-soft, vedi nota 4
    // nel commento d'apertura).
    return new NextResponse(null, { status: 204, headers: corsHeaders() });
  }

  // Validazione minima — i campi obbligatori sono funnel_id (uuid),
  // session_id (string non vuota), event_type (whitelist).
  if (!isUuid(body.funnel_id) || !body.session_id || typeof body.session_id !== 'string') {
    return new NextResponse(null, { status: 204, headers: corsHeaders() });
  }
  const eventType = String(body.event_type || '');
  if (!ALLOWED_EVENT_TYPES.has(eventType)) {
    return new NextResponse(null, { status: 204, headers: corsHeaders() });
  }
  const pageId = isUuid(body.page_id) ? body.page_id : null;

  // User-Agent dalla request — il client non lo manda esplicitamente, lo
  // prendiamo dall'header. Headers nel runtime Node.js Next.js sono
  // case-insensitive.
  const userAgent = trunc(request.headers.get('user-agent'), 512);

  // Best-effort bot detection lato server (additivo a quello client).
  const lowerUa = userAgent.toLowerCase();
  const looksBot =
    Boolean(body.is_bot) ||
    /\bbot\b|crawler|spider|headlesschrome|puppeteer|playwright|phantomjs|googlebot|bingbot|yandex|baiduspider|facebookexternalhit|twitterbot|linkedinbot|slackbot|whatsapp|telegrambot/i.test(
      lowerUa,
    );

  try {
    const sb = getSupabaseAdmin();
    // L'insert deve essere "non bloccante": se Supabase e' giu' o lento, il
    // tracker non riprova (sendBeacon e' fire-and-forget). Limitiamo il
    // tempo con un timeout di 3s — oltre lasciamo perdere.
    const insertPromise = sb.from('analytics_events').insert({
      project_id: body.funnel_id,
      page_id: pageId,
      session_id: trunc(body.session_id, 128),
      event_type: eventType,
      url: trunc(body.url, MAX_FIELD_LENGTH),
      referrer: trunc(body.referrer, MAX_FIELD_LENGTH),
      user_agent: userAgent,
      payload:
        body.payload && typeof body.payload === 'object'
          ? body.payload
          : {},
      is_bot: looksBot,
    });

    const timeoutPromise = new Promise<{ error: { message: string } }>(
      (resolve) => {
        setTimeout(
          () => resolve({ error: { message: 'insert-timeout-3s' } }),
          3000,
        );
      },
    );

    const result = (await Promise.race([insertPromise, timeoutPromise])) as {
      error?: { message: string } | null;
    };

    if (result.error) {
      // Log a livello debug — non vogliamo riempire i log di Vercel con un
      // warning per ogni evento perso. Il singolo evento perso non e'
      // critico, e' il drop-off su volume.
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[/api/track/event] insert error:', result.error.message);
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[/api/track/event] unexpected:', err);
    }
  }

  // 204 No Content: il tracker non gli interessa la risposta (sendBeacon
  // non la legge). Niente body = niente bytes di overhead.
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
