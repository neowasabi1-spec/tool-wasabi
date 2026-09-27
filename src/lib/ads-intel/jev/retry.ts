/** Errori temporanei: vale la pena riprovare dopo un'attesa. */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

export class HttpError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function isTransient(e: unknown): boolean {
  if (e instanceof HttpError) return RETRYABLE_STATUS.has(e.status);
  const msg = e instanceof Error ? e.message : String(e);
  return /\b(429|500|502|503|504|529)\b|rate.?limit|too many requests|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|browser has been closed|too many connections|Target page, context or browser has been closed|Target closed/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch con nuovi tentativi su 429 / 5xx / errori di rete.
 * Rispetta l'header Retry-After; altrimenti attesa esponenziale con un po' di casualità.
 */
export async function fetchRetry(url: string | URL, init?: RequestInit, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (!RETRYABLE_STATUS.has(res.status) || i === attempts - 1) return res;
      const after = Number(res.headers.get('retry-after'));
      await res.body?.cancel().catch(() => {});
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : backoff(i));
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) throw e;
      await sleep(backoff(i));
    }
  }
  throw lastErr;
}

export const backoff = (i: number) => Math.min(30000, 1500 * 2 ** i) + Math.floor(Math.random() * 500);
