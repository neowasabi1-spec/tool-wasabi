/**
 * Robust JSON-response reader.
 *
 * Why: many of our long-running API routes (swipe, clone, audit) can
 * be killed by the Netlify proxy with a 502/504 + an HTML error page.
 * If the client calls `await response.json()` directly on those, the
 * built-in parser explodes with the unhelpful
 *   `Unexpected token '<', "<HTML> <HE"... is not valid JSON`
 * and the user has no idea what actually went wrong.
 *
 * `parseJsonResponse` reads the body once as text, then tries to
 * JSON-parse it. If that fails, it returns a structured error that
 * carries the HTTP status, content-type, and a 500-char preview of
 * the raw body — enough for the UI to show a useful message.
 */
export interface JsonParseResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  rawPreview: string | null;
  contentType: string | null;
}

export async function parseJsonResponse<T = unknown>(
  response: Response,
): Promise<JsonParseResult<T>> {
  const status = response.status;
  const contentType = response.headers.get('content-type');
  let raw = '';
  try {
    raw = await response.text();
  } catch (err) {
    return {
      ok: false,
      status,
      data: null,
      error: `Impossibile leggere la risposta: ${err instanceof Error ? err.message : String(err)}`,
      rawPreview: null,
      contentType,
    };
  }

  // Empty body → only OK if the route returns 204 / 205. Otherwise it's
  // a silent failure (e.g. function killed mid-flight).
  if (!raw.trim()) {
    return {
      ok: response.ok && (status === 204 || status === 205),
      status,
      data: null,
      error: response.ok ? null : `Risposta vuota (HTTP ${status})`,
      rawPreview: null,
      contentType,
    };
  }

  try {
    const data = JSON.parse(raw) as T;
    return {
      ok: response.ok,
      status,
      data,
      error: response.ok ? null : `HTTP ${status}`,
      rawPreview: null,
      contentType,
    };
  } catch {
    // Body wasn't JSON. The most common cause is a Netlify HTML error
    // page from a function timeout (504) or a hard crash (502). Detect
    // these and turn them into something a human can act on.
    const isHtml =
      raw.trimStart().startsWith('<') ||
      contentType?.toLowerCase().includes('html') ||
      contentType?.toLowerCase().includes('xml');
    let friendly: string;
    if (status === 504 || raw.toLowerCase().includes('gateway timeout')) {
      friendly =
        'La richiesta è andata in timeout (la function ha superato il tetto Netlify). Riprova: il cold-start del browser headless può richiedere 10-15s.';
    } else if (status === 502 || raw.toLowerCase().includes('bad gateway')) {
      friendly =
        'La function è crashata (502 Bad Gateway). Probabile out-of-memory o errore non catturato lato server. Controlla i log Netlify.';
    } else if (status >= 500) {
      friendly = `Errore interno del server (HTTP ${status}). La risposta non è JSON.`;
    } else if (isHtml) {
      friendly = `Il server ha risposto con HTML invece di JSON (HTTP ${status}). Probabile errore 4xx/5xx mascherato da pagina di errore.`;
    } else {
      friendly = `Risposta non parseable come JSON (HTTP ${status}).`;
    }
    return {
      ok: false,
      status,
      data: null,
      error: friendly,
      rawPreview: raw.slice(0, 500),
      contentType,
    };
  }
}
