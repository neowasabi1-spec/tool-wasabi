/**
 * OpenClaw Worker — polls Supabase for pending messages and forwards them
 * to the local OpenClaw server. Resilient: auto-reconnects on errors, retries on
 * transient failures, logs verbose status.
 *
 * Usage:
 *   npm install @supabase/supabase-js
 *   node openclaw-worker.js
 *
 * Recommended: run as a Windows service via NSSM so it starts on boot.
 */

const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ===== IN-PROCESS WORKER MODULES ===================================
// Portati dentro al worker da src/app/api/landing/swipe/* per
// eliminare le chiamate HTTP al tool Netlify durante lo swipe.
// L'agente fa tutto in locale: estrazione testi, prompt building,
// rewrite via local LLM, applicazione modifiche all'HTML, scrittura
// risultato finale su Supabase. ZERO 502 da OpenResty / Netlify
// cold-start in mezzo.
const { buildPrompts: buildSwipePrompts } = require('./worker-lib/build-prompts');
const { extractBundleTexts } = require('./worker-lib/bundle-extractor');
const { inlineBundleRewrites } = require('./worker-lib/bundle-inliner');
const { finalizeSwipe: finalizeSwipeLocal } = require('./worker-lib/finalize');

// ===== STATIC EXTRA CONTEXT (per-worker) ============================
// L'utente puo' mettere su questo PC un file di "knowledge personale"
// che il worker iniettera' in OGNI rewrite. Pensato per cose che il
// modello locale non sa di sapere — es. brand book, tone-of-voice
// customer-specific, prodotti del catalogo, claims approvati legalmente.
//
//   1. ENV var OPENCLAW_EXTRA_CONTEXT_FILE=/path/to/notes.md (priorita')
//   2. file `openclaw-extra-context.md` accanto al worker (zero-config)
//
// Se nessuno dei due esiste, niente contesto extra statico (usiamo
// solo il primer + il system prompt del server). Massimo 50_000 chars
// per non saturare la context window.
function loadStaticExtraContext() {
  const envPath = (process.env.OPENCLAW_EXTRA_CONTEXT_FILE || '').trim();
  const candidates = [];
  if (envPath) candidates.push(envPath);
  candidates.push(path.join(__dirname, 'openclaw-extra-context.md'));
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (raw.length > 20) {
          const truncated = raw.length > 50_000 ? raw.substring(0, 50_000) + '\n[…truncated]' : raw;
          return { path: p, content: truncated };
        }
      }
    } catch (_e) { /* keep trying next candidate */ }
  }
  return null;
}
const STATIC_EXTRA_CONTEXT = loadStaticExtraContext();

// Playwright is optional — only needed when this worker also processes
// funnel_crawl_jobs rows (agentic auto-discover for the checkpoint UI).
// If `playwright-core` is missing or no system Chromium is installed
// (`npx playwright install chromium`), the chat / rewrite / checkpoint
// audit pipelines keep working — only the crawl poller is disabled
// at startup with a clear warning.
let playwrightChromium = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  playwrightChromium = require('playwright-core').chromium;
} catch (_e) {
  playwrightChromium = null;
}

// ===== CONFIG =====================================================
const SUPABASE_URL = process.env.SUPABASE_URL
  || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const OPENCLAW_HOST = process.env.OPENCLAW_HOST || '127.0.0.1';
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_PORT || '18789', 10);
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY
  || 'ba893c2470e9f12b281ab1031746b5f177b14a746143b1ab';
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || 'openclaw/trinity';

// ── LLM backend selector ────────────────────────────────────────
// Two backends are wired up:
//
//   - 'openai-compat' (default): forward chat completions to the
//     local OpenClaw / Trinity / Ollama / LM Studio server on
//     OPENCLAW_HOST:OPENCLAW_PORT. This is what Neo uses with
//     Trinity locally.
//
//   - 'anthropic': call the Anthropic Messages API directly at
//     api.anthropic.com. This is what Morfeo uses on the Mac Mini —
//     no local LLM needed, just an Anthropic API key. The OpenAI-
//     style messages are transparently translated to the Messages
//     API format (system → top-level system, user/assistant in the
//     conversation array, content blocks decoded back to plain text
//     so processMessage doesn't need to know which backend ran it).
//
// All other behaviour (queue polling, target_agent routing, swipe
// jobs, rewrite batching, checkpoint_audit pipeline, retries) is
// backend-agnostic and stays identical — Neo and Morfeo claim
// distinct rows from the same queue and only differ in WHO actually
// runs the inference under the hood.
const OPENCLAW_BACKEND = (process.env.OPENCLAW_BACKEND || 'openai-compat')
  .toLowerCase();
const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || process.env.OPENCLAW_API_KEY || '';
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';
// Max output tokens. Anthropic Sonnet/Opus regge 8192; OpenClaw/Trinity
// regge tipicamente fino a 16K (Trinity ha context window 32K, output
// fino a 16K). Default alzato a 16K per i locali: cosi' un'unica call
// "oneshot" puo' restituire 100+ rewrites in un solo round (come fa
// Telegram quando l'utente chatta direttamente con Neo: 1 messaggio,
// 1 risposta lunga). Override via env se il modello locale ha un cap
// piu' basso.
const OPENCLAW_MAX_TOKENS = parseInt(
  process.env.OPENCLAW_MAX_TOKENS
    || (OPENCLAW_BACKEND === 'anthropic' ? '8192' : '16384'),
  10,
);

// ── Agent identity (for explicit Neo vs Morfeo routing) ─────────
// Independent of OPENCLAW_MODEL (which labels the LOCAL LLM the worker
// forwards chat completions to). When this is set, the poll query
// only claims openclaw_messages rows tagged with the same target_agent
// (or untagged legacy rows). When it's null we behave like before
// (first-come-first-served on every pending row).
//
// Resolution order (first one that matches wins):
//   1. OPENCLAW_AGENT env var (explicit override).
//   2. Auto-detect from the OS username and computer name. This is
//      the zero-config path: on the PC where the Windows user is
//      "Neo" we become openclaw:neo, on a PC owned by "Morfeo" /
//      "Morpheus" we become openclaw:morfeo. Works on Linux too via
//      `os.userInfo().username`.
//   3. null  → legacy mode, no routing (acts like before this patch).
function resolveAgentIdentity() {
  const explicit = (process.env.OPENCLAW_AGENT || '').trim();
  if (explicit) return explicit;
  const name = `${os.userInfo().username || ''} ${os.hostname() || ''}`.toLowerCase();
  if (/\bneo\b|trinity/.test(name)) return 'openclaw:neo';
  if (/morfeo|morpheus/.test(name)) return 'openclaw:morfeo';
  return null;
}
const OPENCLAW_AGENT = resolveAgentIdentity();

const TOOL_BASE_URL = process.env.TOOL_BASE_URL
  || 'https://tool-wasabi-neo.netlify.app';

const POLL_INTERVAL_MS = 3000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const OPENCLAW_TIMEOUT_MS = 30 * 60 * 1000;          // 30 minutes per chat message
const SWIPE_JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;     // 6 hours per swipe job
const MAX_CONSECUTIVE_POLL_ERRORS = 20;

// ===== STATE ======================================================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let consecutivePollErrors = 0;
let totalProcessed = 0;
let totalErrors = 0;
let isProcessing = false;

const stamp = () => new Date().toISOString().replace('T', ' ').substring(0, 19);

// ── File-based logging ───────────────────────────────────────────
// A prescindere da come il worker viene avviato (node openclaw-worker.js
// in PowerShell, tramite .bat, via NSSM, launchd, ecc), scriviamo SEMPRE
// ogni riga di log anche su file `openclaw-worker.log` accanto al worker.
// Cosi' l'utente puo' sempre fare Get-Content / tail per debug, senza
// dover stare a copiare dalla finestra PowerShell.
//
// Comportamento:
//   - Append (no overwrite): la prima riga ad ogni avvio e' un separator
//     "======== WORKER STARTED <ts> PID=<n> ========"
//   - Cap di rotazione semplice: se il file > 20MB, lo trunchiamo a 5MB
//     (taglio dall'inizio) cosi' non cresce all'infinito.
const LOG_FILE = path.join(__dirname, 'openclaw-worker.log');
const MAX_LOG_SIZE = 20 * 1024 * 1024;     // 20 MB
const LOG_TRUNCATE_TO = 5 * 1024 * 1024;   // dopo rotazione, tieni gli ultimi 5MB
function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > MAX_LOG_SIZE) {
      const fd = fs.openSync(LOG_FILE, 'r');
      const buf = Buffer.alloc(LOG_TRUNCATE_TO);
      fs.readSync(fd, buf, 0, LOG_TRUNCATE_TO, st.size - LOG_TRUNCATE_TO);
      fs.closeSync(fd);
      fs.writeFileSync(LOG_FILE, '== [log truncated for size] ==\n' + buf.toString('utf8'));
    }
  } catch { /* file probabilmente non esiste ancora, OK */ }
}
function writeLogFile(line) {
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* swallow */ }
}
rotateLogIfNeeded();
writeLogFile(`\n======== WORKER STARTED ${new Date().toISOString()} PID=${process.pid} ========`);

const log = (...args) => {
  const line = `[${stamp()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.log(line);
  writeLogFile(line);
};
const err = (...args) => {
  const line = `[${stamp()}] ERROR ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.error(line);
  writeLogFile(line);
};

// ===== LLM CALLS ==================================================
// Dispatcher: route the chat completion to whichever backend the
// worker was configured for. Both backends accept and return the
// same shape (OpenAI-style messages in, plain string out), so the
// rest of the worker doesn't need to know which one ran.
function callOpenClaw(messages) {
  if (OPENCLAW_BACKEND === 'anthropic') return callAnthropic(messages);
  return callOpenClawNative(messages);
}

// OpenAI-compatible local HTTP call (Trinity / Ollama / LM Studio /
// vLLM / llama.cpp server). Default for the Neo PC.
function callOpenClawNative(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OPENCLAW_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: OPENCLAW_MAX_TOKENS,
    });

    const req = http.request({
      hostname: OPENCLAW_HOST,
      port: OPENCLAW_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_API_KEY}`,
        'Host': `${OPENCLAW_HOST}:${OPENCLAW_PORT}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: OPENCLAW_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            resolve(data.choices?.[0]?.message?.content || '');
          } catch (e) {
            reject(new Error('Invalid JSON from OpenClaw: ' + body.substring(0, 200)));
          }
        } else {
          reject(new Error(`OpenClaw HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`OpenClaw timeout after ${OPENCLAW_TIMEOUT_MS / 1000}s`));
    });
    req.on('error', (e) => reject(new Error(`OpenClaw network error: ${e.message}`)));
    req.write(payload);
    req.end();
  });
}

// ── Pricing & usage logging ─────────────────────────────────────
// USD per 1M tokens. Keep this in sync with Anthropic's pricing page;
// numbers below are public list prices as of mid-2025. Used by the
// /api-usage dashboard to compute "spesa di oggi" without re-fetching
// invoices. If a model is missing here we fall back to Sonnet pricing
// and tag `metadata.pricing_fallback = true` so the dashboard can show
// it as an estimate.
const ANTHROPIC_PRICING = {
  'claude-sonnet-4-20250514':       { input: 3.00,  output: 15.00 },
  'claude-3-5-sonnet-20241022':     { input: 3.00,  output: 15.00 },
  'claude-3-5-sonnet-20240620':     { input: 3.00,  output: 15.00 },
  'claude-3-5-haiku-20241022':      { input: 0.80,  output: 4.00  },
  'claude-3-opus-20240229':         { input: 15.00, output: 75.00 },
  'claude-opus-4-20250514':         { input: 15.00, output: 75.00 },
  'claude-haiku-4-20250514':        { input: 0.80,  output: 4.00  },
};

function pricingFor(provider, model) {
  if (provider === 'anthropic') {
    return ANTHROPIC_PRICING[model] || { input: 3.00, output: 15.00, fallback: true };
  }
  return null;
}

function computeCostUsd(provider, model, inputTokens, outputTokens) {
  const p = pricingFor(provider, model);
  if (!p) return 0;
  const inCost = (inputTokens / 1_000_000) * p.input;
  const outCost = (outputTokens / 1_000_000) * p.output;
  return Number((inCost + outCost).toFixed(6));
}

// Fire-and-forget Supabase insert — never throws, never blocks the
// caller. If the table doesn't exist yet (migration not applied) we
// silently swallow; the worker keeps running and the user just sees
// $0 in the dashboard until they apply supabase-migration-api-usage-log.sql.
async function logApiUsage({ provider, model, inputTokens, outputTokens, source, durationMs, metadata }) {
  try {
    const cost = computeCostUsd(provider, model, inputTokens, outputTokens);
    await supabase.from('api_usage_log').insert({
      provider,
      model,
      input_tokens: inputTokens || 0,
      output_tokens: outputTokens || 0,
      cost_usd: cost,
      source: source || null,
      agent: OPENCLAW_AGENT || null,
      duration_ms: durationMs ?? null,
      metadata: metadata || null,
    });
  } catch (e) {
    // Non-fatal — usage logging must never break the actual job.
    err(`logApiUsage failed: ${e.message}`);
  }
}

// Anthropic Messages API call. Used by Morfeo on the Mac Mini —
// no local LLM, just an Anthropic API key. We translate the
// OpenAI-shaped `messages` array into the Anthropic format:
//   - the first/concatenated `role: 'system'` entries become the
//     top-level `system` field
//   - everything else stays as { role, content } in `messages`
//   - the response's `content[].text` blocks are joined back into
//     a single string so the rest of the worker is unchanged.
// Optional context attached to the next callAnthropic invocation so
// logApiUsage can record WHICH job/section this call belonged to.
// Set with `withCallContext({ source, metadata }, fn)` for clarity.
let _callContext = null;
function withCallContext(ctx, fn) {
  const prev = _callContext;
  _callContext = ctx || null;
  try {
    return fn();
  } finally {
    _callContext = prev;
  }
}

function callAnthropic(messages) {
  const callStartedAt = Date.now();
  const callCtx = _callContext;
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_API_KEY) {
      return reject(
        new Error(
          'OPENCLAW_BACKEND=anthropic but no ANTHROPIC_API_KEY (or OPENCLAW_API_KEY) is set. Export ANTHROPIC_API_KEY=sk-ant-... and restart the worker.',
        ),
      );
    }

    let systemPrompt = '';
    const conv = [];
    for (const m of messages || []) {
      if (!m || typeof m.content !== 'string') continue;
      if (m.role === 'system') {
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n${m.content}`
          : m.content;
        continue;
      }
      if (m.role === 'user' || m.role === 'assistant') {
        conv.push({ role: m.role, content: m.content });
      }
    }
    if (conv.length === 0) {
      return reject(
        new Error(
          'callAnthropic: no user/assistant messages to send (translation produced an empty conversation)',
        ),
      );
    }

    const body = {
      model: OPENCLAW_MODEL,
      max_tokens: OPENCLAW_MAX_TOKENS,
      messages: conv,
    };
    if (systemPrompt) body.system = systemPrompt;
    const payload = JSON.stringify(body);

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: OPENCLAW_TIMEOUT_MS,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(buf);
              const text = Array.isArray(data.content)
                ? data.content
                    .filter(
                      (b) => b && b.type === 'text' && typeof b.text === 'string',
                    )
                    .map((b) => b.text)
                    .join('')
                : '';
              // Log spend (fire-and-forget — never blocks resolve).
              const usage = data.usage || {};
              logApiUsage({
                provider: 'anthropic',
                model: data.model || OPENCLAW_MODEL,
                inputTokens:
                  (usage.input_tokens || 0) +
                  (usage.cache_creation_input_tokens || 0) +
                  (usage.cache_read_input_tokens || 0),
                outputTokens: usage.output_tokens || 0,
                source: (callCtx && callCtx.source) || 'worker',
                durationMs: Date.now() - callStartedAt,
                metadata: callCtx && callCtx.metadata,
              }).catch(() => {});
              resolve(text);
            } catch (e) {
              reject(
                new Error(
                  'Invalid JSON from Anthropic: ' + buf.substring(0, 200),
                ),
              );
            }
          } else {
            reject(
              new Error(
                `Anthropic HTTP ${res.statusCode}: ${buf.substring(0, 300)}`,
              ),
            );
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(
        new Error(`Anthropic timeout after ${OPENCLAW_TIMEOUT_MS / 1000}s`),
      );
    });
    req.on('error', (e) =>
      reject(new Error(`Anthropic network error: ${e.message}`)),
    );
    req.write(payload);
    req.end();
  });
}

// ===== TOOL API CALL (for swipe jobs) =============================
// Internal one-shot; do not call directly outside this file — use
// callToolApi (the retry wrapper below) for everything that goes
// through the Netlify edge / OpenResty proxy, perche' transient 502/
// 503/504/ECONNRESET sono normali su Netlify quando la funzione e' a
// cold-start o ha appena finito un'altra invocazione lunga.
function callToolApiOnce(path, body, timeoutMs, method = 'POST') {
  return new Promise((resolve, reject) => {
    const u = new URL(path, TOOL_BASE_URL);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const isGet = method.toUpperCase() === 'GET';
    const payload = isGet ? '' : JSON.stringify(body ?? {});

    const headers = isGet
      ? { 'Accept': 'application/json' }
      : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        };

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: method.toUpperCase(),
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); }
          catch { resolve({ raw: buf }); }
        } else {
          const e = new Error(`Tool API HTTP ${res.statusCode}: ${buf.substring(0, 300)}`);
          e.statusCode = res.statusCode;
          reject(e);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const e = new Error(`Tool API timeout after ${(timeoutMs / 1000).toFixed(0)}s`);
      e.code = 'ETIMEDOUT';
      reject(e);
    });
    req.on('error', (e) => {
      const wrap = new Error(`Tool API network error: ${e.message}`);
      wrap.code = e.code;
      reject(wrap);
    });
    if (!isGet) req.write(payload);
    req.end();
  });
}

// Retry wrapper. Su 502/503/504 (OpenResty / Netlify cold-start /
// upstream timeout) e su ECONNRESET / ETIMEDOUT / ECONNREFUSED /
// ECONNABORTED / EAI_AGAIN, riproviamo fino a 3 volte con backoff
// esponenziale (1s, 3s, 7s). Altri errori (400/422/...) NON sono
// transient e ritornano subito al chiamante.
//
// I 502 sono frequenti quando Netlify spegne una function instance
// dopo idle e la prossima chiamata trova il pod ancora warm-up: il
// proxy OpenResty davanti restituisce 502 mentre l'istanza non e'
// pronta. Un secondo tentativo dopo 1s tipicamente la trova viva.
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
]);
function isTransientError(err) {
  if (err && typeof err.statusCode === 'number' && TRANSIENT_STATUS.has(err.statusCode)) return true;
  if (err && err.code && TRANSIENT_CODES.has(err.code)) return true;
  if (err && err.message) {
    const m = err.message;
    if (/HTTP (502|503|504)\b/.test(m)) return true;
    if (/network error|timeout after|socket hang up|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNABORTED|ECONNREFUSED/i.test(m)) return true;
  }
  return false;
}
async function callToolApi(path, body, timeoutMs, method = 'POST') {
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [1000, 3000, 7000];
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callToolApiOnce(path, body, timeoutMs, method);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS && isTransientError(e)) {
        const wait = BACKOFF_MS[attempt - 1];
        log(`  · Tool API ${method} ${path} fallita (tentativo ${attempt}/${MAX_ATTEMPTS}): ${e.message.substring(0, 160)} — riprovo tra ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Write a "[stage] <msg>" hint to funnel_checkpoints.error so the
 * dashboard's polling client can surface "what is the worker doing
 * RIGHT NOW" in the activity monitor while the local page-fetch is
 * in progress. Replaces the old server-side writeStageHint that ran
 * inside openclaw-prep — now that prep is local, we have to write
 * the hint ourselves directly via Supabase.
 *
 * Non-fatal: a Supabase blip during a fetch must NEVER fail the run.
 */
async function writeCheckpointStageHint(runId, msg) {
  if (!runId || !msg) return;
  try {
    await supabase
      .from('funnel_checkpoints')
      .update({ error: `[stage] ${msg}` })
      .eq('id', runId);
  } catch (e) {
    // Soft-fail by design — the whole monitor is a "nice to have".
    err(`writeCheckpointStageHint failed: ${e && e.message ? e.message : String(e)}`);
  }
}

// ===== REWRITE BATCHING ==========================================
// Quando il prompt è una richiesta di rewrite Trinity (section === 'Rewrite' o
// 'Quiz Rewrite'), il userMessage contiene un JSON array `textsForAi` che può
// essere troppo grande per la context window del modello locale. Lo splittiamo
// in chunk e aggreghiamo i risultati.

// REWRITE_QUALITY_MODE controlla la strategia di rewrite:
//   'oneshot' (DEFAULT) → 1 call con TUTTI i testi insieme, come fa
//                         Telegram. Neo vede la landing intera, applica
//                         tecniche coerenti, restituisce tutto in 1
//                         risposta lunga. 1-3 min totali, qualita' max.
//                         Limite: il modello locale deve reggere
//                         (context >= 16K + max_tokens output >= 8K).
//                         Se la landing e' enorme (>200 testi) si fanno
//                         comunque batch grossi (200/round).
//   'fast'              → batch JSON da 5 sequenziale. Vecchio default,
//                         compatibile con modelli locali stretti (8K).
//                         ~20 min su una landing da 100 testi.
//   'high'              → batch JSON da 3, hint "pensa 2-3 candidati".
//   'ultra'             → batch JSON da 1.
//   'chat'              → 1 call conversazionale per OGNI testo. Lento
//                         ma triggera RAG nativo. Usato anche come
//                         fallback automatico nell'ULTIMO gap-fill pass
//                         a prescindere dalla mode scelta.
const REWRITE_QUALITY_MODE = (process.env.REWRITE_QUALITY_MODE || 'oneshot').toLowerCase();
const QUALITY_DEFAULTS = {
  // 'oneshot' (NUOVO DEFAULT) — POCHE call grandi invece di tante piccole.
  // batchSize 30 e' il sweet spot empirico per OpenClaw / Trinity locale:
  //   - oltre 50 testi/batch il server locale chiude la connessione con
  //     ECONNABORTED (body POST troppo grande per /v1/chat/completions)
  //   - 30 testi/batch + system prompt da ~12K char = body ~18K = OK
  //   - una landing da 100 testi → ~3-4 batch, in parallelo (3 in flight)
  //     = 1-2 round = 2-4 min totali
  // Override via REWRITE_BATCH_SIZE se il setup locale regge di piu'.
  oneshot: { batchSize: 30 },
  // 5 e' il sweet spot empirico per Trinity locale (vecchio default
  // 'fast'): abbastanza piccolo da non far omettere id al modello,
  // abbastanza grande da non moltiplicare le call. Mantenuto per
  // compatibilita' con setup vecchi e per modelli locali con
  // context window stretto (8K) che non reggono il oneshot.
  fast: { batchSize: 5 },
  high: { batchSize: 3 },
  ultra: { batchSize: 1 },
  // 'chat' mode: NESSUN batch JSON. Per ogni testo facciamo una call
  // conversazionale come se l'utente avesse scritto in chat al modello
  // (system minimale, prompt naturale, risposta libera). Bypassa
  // completamente la pressione "form filler" che fa scrivere male il
  // modello locale. Lento (~1 call per testo) ma e' la qualita' che
  // si vede quando si chatta direttamente con Neo / Morfeo nel tool.
  chat: { batchSize: 1 },
};
const QUALITY_BATCH_DEFAULT = (QUALITY_DEFAULTS[REWRITE_QUALITY_MODE] || QUALITY_DEFAULTS.fast).batchSize;
const REWRITE_BATCH_SIZE = parseInt(
  process.env.REWRITE_BATCH_SIZE || String(QUALITY_BATCH_DEFAULT),
  10,
);

function isRewriteSection(section) {
  return section === 'Rewrite' || section === 'Quiz Rewrite';
}

function parseTextsFromRewritePrompt(userMessage) {
  // Cerca il blocco JSON tra "Testi da riscrivere (JSON):" e "Riscrivi".
  const startMarker = 'Testi da riscrivere (JSON):';
  const endMarker = 'Riscrivi';
  const start = userMessage.indexOf(startMarker);
  const end = userMessage.indexOf(endMarker, start >= 0 ? start : 0);
  if (start < 0 || end < 0 || end <= start) return null;
  const raw = userMessage.substring(start + startMarker.length, end).trim();
  // Trova il primo '[' e l'ultimo ']' di quel sotto-blocco.
  const a = raw.indexOf('[');
  const b = raw.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const parsed = JSON.parse(raw.substring(a, b + 1));
    if (!Array.isArray(parsed)) return null;
    return { texts: parsed, beforeJson: userMessage.substring(0, start + startMarker.length), afterJson: userMessage.substring(end) };
  } catch {
    return null;
  }
}

function extractRewritesFromAiResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  let cleaned = text.trim();
  // Rimuovi tutti i fence code in qualunque punto (a volte il modello mette
  // ```json ... ``` a meta' della risposta, non solo all'inizio).
  cleaned = cleaned.replace(/```(?:json|JSON)?\s*/g, '').replace(/```/g, '');
  const a = cleaned.indexOf('[');
  const b = cleaned.lastIndexOf(']');
  if (a >= 0 && b > a) {
    const slice = cleaned.substring(a, b + 1);
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // continua sotto: fallback parser
    }
  }
  // Fallback: il modello ha rotto il JSON (es. virgola finale, escape mancante,
  // newline dentro una stringa). Estraiamo manualmente tutti gli oggetti
  // {"id": N, "rewritten": "..."} con regex tollerante. Non perfetto ma
  // recupera la maggior parte degli id buoni.
  const recovered = [];
  const pattern = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"rewritten"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = pattern.exec(cleaned)) !== null) {
    const id = parseInt(m[1], 10);
    if (Number.isNaN(id)) continue;
    let rewritten;
    try {
      rewritten = JSON.parse(`"${m[2]}"`);
    } catch {
      rewritten = m[2];
    }
    recovered.push({ id, rewritten });
  }
  return recovered;
}

// Numero di pass di "gap-fill" per recuperare id saltati o echi.
// Ogni pass usa un batch sempre piu' piccolo. Default alzato a 4: il
// modello locale (Trinity / equivalenti) salta facilmente id se i
// batch sono grandi, e l'unico modo per recuperarli affidabilmente
// e' iterare con prompt sempre piu' aggressivi e batch sempre piu'
// piccoli. L'ULTIMO pass viene sempre fatto a batch=1 (un testo per
// call) per garantire la massima copertura.
const REWRITE_GAP_FILL_PASSES = parseInt(process.env.REWRITE_GAP_FILL_PASSES || '4', 10);

// ─── CONVERSATIONAL REWRITE (chat-style) ──────────────────────────
// Estrae il "product context" + tono dal system prompt server-side.
// Server-side il prompt e' in italiano e ha una sezione delimitata
// "CONTESTO PRODOTTO COMPLETO (...): ${productCtx}"; preferiamo
// estrarre solo quella sezione + nome prodotto, cosi' la chat vede
// solo cio' che le serve davvero.
function extractProductContextFromSystemPrompt(systemPrompt) {
  if (typeof systemPrompt !== 'string') return { productName: '', context: '' };
  let productName = '';
  const nameMatch = systemPrompt.match(/PRODOTTO:\s*(.+)/i)
    || systemPrompt.match(/PRODUCT NAME:\s*(.+)/i);
  if (nameMatch) productName = nameMatch[1].trim();

  // Estraiamo TRE blocchi dal system prompt, in ordine di priorità per il
  // chat-style. Senza questi blocchi Neo/Morfeo riceve solo {id,text,tag} +
  // nome prodotto e produce copy generico (bug confermato leggendo le
  // sessioni in .openclaw/agents/trinity/sessions/*.jsonl del 16/05):
  //   A. PRODUCT FACTS    → cheat-sheet di fatti concreti (dottori, durate,
  //                          prezzi, garanzie). SENZA QUESTA, il chat-style
  //                          non può fare fact-substitution e lascia
  //                          "Dr. Sarah Johnson" / "15 minutes" / "$97"
  //                          dell'originale.
  //   B. ANALISI PREP     → big idea + leve + tecniche maestri citate dal
  //                          primer iniziale. SENZA QUESTA, ogni gap-fill
  //                          va in direzione diversa rompendo la coerenza
  //                          narrativa del batch principale.
  //   C. CONTESTO PRODOTTO→ brief + market research + benefits del prodotto.
  function extractBlock(start, stopRegex) {
    const idx = systemPrompt.search(start);
    if (idx < 0) return '';
    const after = systemPrompt.substring(idx);
    const sepIdx = after.search(/[:\n]/);
    if (sepIdx < 0) return '';
    const body = after.substring(sepIdx + 1);
    const stopIdx = body.search(stopRegex);
    return (stopIdx >= 0 ? body.substring(0, stopIdx) : body).trim();
  }

  const productFacts = extractBlock(
    /===\s*PRODUCT FACTS/i,
    /\n===\s*FINE PRODUCT FACTS|\n===\s*KNOWLEDGE|\n===\s*COPYWRITING|\nCONTESTO PRODOTTO|\nFULL PRODUCT CONTEXT|\nTONO|\nTONE|\nLINGUA|\nOUTPUT LANGUAGE|\nREGOLE|\nCRITICAL RULES/i,
  );

  const agentPrep = extractBlock(
    /===\s*ANALISI PREP DELL'AGENTE/i,
    /\n===\s*FINE ANALISI PREP|\n===\s*KNOWLEDGE STATICA|\n===\s*FINE KNOWLEDGE/i,
  );

  const productCtx = extractBlock(
    /CONTESTO PRODOTTO COMPLETO|FULL PRODUCT CONTEXT/i,
    /\n\s*===\s*COPYWRITING FRAMEWORK|\n\s*===\s*KNOWLEDGE|\n\s*TONO|\n\s*TONE|\n\s*LINGUA|\n\s*OUTPUT LANGUAGE|\n\s*REGOLE|\n\s*CRITICAL RULES/i,
  );

  const parts = [];
  if (productFacts) parts.push(`=== PRODUCT FACTS (sostituisci ogni fatto equivalente del competitor con QUESTI) ===\n${productFacts}`);
  if (agentPrep) parts.push(`=== BIG IDEA + LEVE + TECNICHE GIA' SCELTE PER QUESTA LANDING (rispettale, NON cambiare direzione) ===\n${agentPrep}`);
  if (productCtx) parts.push(`=== CONTESTO PRODOTTO (brief + market research) ===\n${productCtx}`);

  let context = parts.join('\n\n');
  // Cap globale: chat-style fa 1 call per testo, non vogliamo prompt
  // giganti × N testi. PRODUCT FACTS è il pezzo più importante quindi
  // viene per primo e sopravvive al taglio anche se gli altri due
  // vengono troncati.
  const CAP = 8000;
  if (context.length > CAP) {
    context = context.substring(0, CAP - 80) + '\n[...troncato per chat-mode: il system prompt globale del batch principale ha già visto tutto.]';
  }
  return { productName, context };
}

// Mimicra ESATTAMENTE come la UI del tool chatta con Neo/Morfeo:
// system minimale, user message in linguaggio naturale, risposta libera.
// Differenza fondamentale vs runBatch: niente JSON, niente batch, niente
// regole su lunghezza/format, il modello scrive come scriverebbe in chat.
// Fast-path: alcuni "testi" estratti dalla pagina sono in realtà valori
// tecnici (viewport, charset, dimensioni, color hex, percentuali, ID
// numerici, CSS shorthand). Su questi il modello giustamente rifiuta di
// fare copywriting e ritorna l'originale identico, ma ogni call paga
// ~$1.20 di cacheWrite. Li riconosciamo e li short-circuitiamo PRIMA
// della call (verificato leggendo agents/trinity/sessions/*.jsonl: il
// modello sta sprecando soldi su "width=device-width, initial-scale=1.0").
function isNonCopyTechnicalValue(text, tag) {
  if (typeof text !== 'string') return true;
  const t = text.trim();
  if (!t) return true;
  // Troppo corto per essere copy
  if (t.length < 4) return true;
  if (!/[a-zA-Z]/.test(t)) return true;
  // Solo numeri / unità / percentuali / valute / dimensioni
  if (/^[\d\s.,:%$€£¥+\-/x×]+$/.test(t)) return true;
  // Color hex / rgb / hsl
  if (/^#?[0-9a-f]{3,8}$/i.test(t)) return true;
  if (/^(?:rgb|rgba|hsl|hsla|var|calc|url)\s*\(/i.test(t)) return true;
  // Viewport / charset / meta http-equiv typical values
  if (/^\s*(?:width|height|initial-scale|maximum-scale|minimum-scale|user-scalable|viewport-fit)\s*=/i.test(t)) return true;
  if (/^(?:utf-8|utf-16|iso-8859-\d+|windows-12\d{2})$/i.test(t)) return true;
  if (/^(?:no-cache|no-store|public|private|max-age|noindex|nofollow|index|follow|noimageindex|noarchive|notranslate|origin|same-origin|cross-origin|anonymous|use-credentials)/i.test(t)) return true;
  // CSS class / id-like (no spaces, kebab/snake/camel only, no real words)
  if (/^[a-zA-Z][\w-]{0,40}$/.test(t) && !/\s/.test(t) && t.length < 25) {
    // Permetti se sembra una parola reale (ha vocali in posizione "naturale")
    const vowelRatio = (t.match(/[aeiouAEIOU]/g) || []).length / t.length;
    if (vowelRatio < 0.2) return true;
  }
  // URL / path / email / coordinate
  if (/^https?:\/\//i.test(t)) return true;
  if (/^\/[\w\-./]+$/.test(t)) return true;
  if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(t)) return true;
  // Date / time iso-like
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return true;
  // Hint dal tag estrattore: sono tecnici quasi sempre
  if (tag) {
    const lower = String(tag).toLowerCase();
    if (/^attr:meta-content$/.test(lower)) {
      // i meta tag content sono quasi sempre tecnici (viewport, charset,
      // robots), TRANNE description / og:description / twitter:description
      // — quelli portano copy. Senza il nome dell'attributo "name" qui non
      // possiamo distinguere, ma il batch principale li avrà gestiti coi
      // markers giusti. Nel gap-fill chat-style li skippiamo.
      return true;
    }
    if (/^attr:(?:href|src|action|formaction|cite|data|srcset|sizes|integrity|crossorigin|rel|media|target|type|class|id|name|for|role|tabindex|aria-(?!label|labelledby|describedby)|data-(?!.*text|.*title|.*description|.*heading|.*subtitle|.*caption|.*label))/i.test(lower)) {
      return true;
    }
  }
  return false;
}

async function rewriteOneTextChatStyle({ id, originalText, tag, productName, productContext, lang }) {
  // Skip valori tecnici prima della call (vedi isNonCopyTechnicalValue)
  if (isNonCopyTechnicalValue(originalText, tag)) {
    log(`    ↩ chat-style id=${id}: valore tecnico/non-copy (${(tag || 'no-tag')}), skip call e ritorno originale`);
    return null;
  }
  const langLabel = lang === 'en' ? 'English' : (lang === 'it' || !lang ? 'italiano' : lang);
  const tagHint = tag ? ` (appare come <${tag.replace(/^(tag|mixed|attr):/, '')}> nella pagina)` : '';
  // System minimale: stesso pattern di quando l'utente scrive a Neo
  // in chat normale nel tool. Niente JSON pressure, niente "regole
  // obbligatorie", solo identita' agente + lingua. Cosi' Neo/Morfeo
  // entrano nel loop tool-use nativo (RAG/archivi/skill).
  const sys = `Sei Neo / Morfeo — un agente di direct-response copywriting con accesso completo ai tuoi archivi prodotti, alla tua knowledge base, ai tuoi tool RAG e a tutte le skill di copywriting che hai accumulato. Quando l'utente ti chiede una riscrittura, comportati come quando ti chatta direttamente: consulta archivi, applica framework, pesca esempi, e ritorna copy di qualita' professionale. Rispondi sempre in ${langLabel}.`;
  const userMsg = [
    `Ehi, ho bisogno di te. Sto riscrivendo una landing per il prodotto "${productName || 'target'}" e voglio che TU riscriva questa frase usando le tue tecniche, archivi e tutto quello che sai.`,
    productContext ? `\nIl contesto prodotto e' questo:\n${productContext}\n` : '',
    `\nLa frase originale${tagHint} e':`,
    `"""${originalText}"""`,
    '',
    'Voglio una versione riscritta che venda davvero il MIO prodotto (non l\'originale parafrasato), che applichi la tua expertise direct-response, e che peschi dai tuoi archivi se hai prodotti / claim / hook simili che hanno funzionato.',
    '',
    'Mandami SOLO il testo finale riscritto. Niente preamboli ("Ecco la riscrittura:", "Ho applicato X tecnica:", ecc), niente virgolette attorno, niente markdown, niente commenti — voglio direttamente la frase pronta da incollare in pagina.',
  ].filter(Boolean).join('\n');
  let raw;
  try {
    raw = await callOpenClaw([
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ]);
  } catch (e) {
    log(`    ✗ chat-style id=${id}: agente ha errato (${e.message})`);
    return null;
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    log(`    ✗ chat-style id=${id}: agente ha risposto VUOTO`);
    return null;
  }
  const rawLen = raw.length;
  let cleaned = raw.trim();
  // Rimuovi preamboli comuni se il modello li ha aggiunti.
  cleaned = cleaned
    .replace(/^(?:ecco(?:\s+la|\s+il)?\s+(?:rewrite|riscrittura|versione|testo riscritto)[\s:.\-]*)/i, '')
    .replace(/^(?:rewritten|riscritto|version|versione)[\s:.\-]*/i, '')
    .trim();
  // Rimuovi fence markdown ovunque siano.
  cleaned = cleaned.replace(/```(?:[a-z]+)?\s*/gi, '').replace(/```/g, '').trim();
  // Rimuovi virgolette wrap se l'intera risposta e' tra " " o « » o "..."
  while (
    (cleaned.startsWith('"') && cleaned.endsWith('"'))
    || (cleaned.startsWith('«') && cleaned.endsWith('»'))
    || (cleaned.startsWith('"') && cleaned.endsWith('"'))
    || (cleaned.startsWith('“') && cleaned.endsWith('”'))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  // Se la risposta e' MOLTO piu' lunga dell'originale (3x), probabilmente
  // l'agente ha aggiunto spiegazioni / opzioni. Tagliamo alle prime 1-2
  // righe sostanziali, oppure scartiamo se sembra una conversazione vera.
  if (cleaned.length > Math.max(originalText.length * 3, 400)) {
    // Se contiene markers tipici di explanation, rifiutiamo cosi' va in fallback.
    if (/^(opzione|option|versione|alternative|alternativa|vers\.|v[12345]|1\.|2\.|3\.)/im.test(cleaned)
        || /\?$/m.test(cleaned.split('\n')[0] || '')) {
      log(`    ⚠ chat-style id=${id}: agente ha risposto con opzioni/spiegazione (${rawLen} char), scarto`);
      return null;
    }
    // Altrimenti tieni solo la prima riga sostanziosa.
    const firstLine = cleaned.split(/\n+/).map((l) => l.trim()).find((l) => l.length > 10);
    if (firstLine) {
      log(`    ⚠ chat-style id=${id}: risposta lunga ${rawLen} char, prendo solo prima riga (${firstLine.length} char)`);
      cleaned = firstLine;
    }
  }
  // Rifiuto echi.
  if (cleaned === originalText.trim() && originalText.length > 20) {
    log(`    ✗ chat-style id=${id}: agente ha rispedito l'originale (echo)`);
    return null;
  }
  if (!cleaned) {
    log(`    ✗ chat-style id=${id}: dopo cleanup la risposta e' vuota`);
    return null;
  }
  return cleaned;
}

async function runRewriteInBatches(systemPrompt, userMessage) {
  const parsed = parseTextsFromRewritePrompt(userMessage);
  if (!parsed) {
    return await callOpenClaw([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ]);
  }

  const { texts, beforeJson, afterJson } = parsed;
  const total = texts.length;
  if (total === 0) return JSON.stringify([]);

  // ─── Modalita' CHAT: bypass totale del JSON ────────────────────────
  // Se l'utente ha settato REWRITE_QUALITY_MODE=chat, non facciamo
  // batch JSON. Ogni testo viene chiesto al modello in linguaggio
  // naturale (come l'utente fa quando chatta direttamente con
  // Neo/Morfeo nel tool, dove il risultato e' molto migliore).
  // Lento (1 call per testo) ma garantisce la stessa qualita' della chat.
  if (REWRITE_QUALITY_MODE === 'chat') {
    log(`  ▸ Rewrite chat-mode: ${total} testi, 1 chiamata conversazionale ciascuno`);
    const { productName, context: productContext } = extractProductContextFromSystemPrompt(systemPrompt);
    // Detect lingua dal system prompt server-side
    const langMatch = systemPrompt.match(/(?:LINGUA|OUTPUT LANGUAGE).*?:\s*([a-zA-Z]+)/i);
    const lang = langMatch ? langMatch[1].toLowerCase().slice(0, 2) : 'it';
    const allRewrites = [];
    let trueRewrites = 0;
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (!t || typeof t.id !== 'number') continue;
      if ((i + 1) % 10 === 0 || i === 0) log(`  ▸ chat-mode ${i + 1}/${total}`);
      const rewritten = await rewriteOneTextChatStyle({
        id: t.id,
        originalText: t.text,
        tag: t.tag,
        productName,
        productContext,
        lang,
      });
      if (rewritten) {
        allRewrites.push({ id: t.id, rewritten });
        trueRewrites++;
      } else {
        // Echo o fail: fallback all'originale per non lasciare l'id missing.
        allRewrites.push({ id: t.id, rewritten: t.text });
      }
    }
    const skipped = total - trueRewrites;
    log(`  ▸ Rewrite done (chat-mode): ${trueRewrites}/${total} VERAMENTE riscritti, ${skipped} restano = originale`);
    return JSON.stringify(allRewrites);
  }

  // Map id -> rewritten string. Usiamo una Map così l'ultima riscrittura buona
  // sovrascrive eventuali risposte precedenti per lo stesso id (gap-fill).
  const idToRewrite = new Map();
  let batchCount = 0;

  // Per il check "echo" ci serve l'originale di ogni id.
  const idToOriginal = new Map();
  for (const t of texts) {
    if (t && typeof t.id === 'number' && typeof t.text === 'string') {
      idToOriginal.set(t.id, t.text.trim());
    }
  }

  // ─── Quality booster ─────────────────────────────────────────────
  // Iniettato nel user message di OGNI batch del rewrite: dice
  // esplicitamente al modello di pensare per ogni testo, di usare
  // archivi/skill/tecniche, e di NON dare una rewrite generica al
  // primo tentativo. Risolve il problema "in chat sono molto meglio":
  // li forziamo a entrare in "thinking mode" anche dentro al pipeline.
  // Il booster e' progressivo:
  //   fast  → reminder breve (no overhead percepibile)
  //   high  → richiesta esplicita di 2-3 candidate + pick best mentale
  //   ultra → workflow per-testo dettagliato + anti-eco aggressivo
  function buildQualityBooster() {
    if (REWRITE_QUALITY_MODE === 'ultra') {
      return [
        '',
        '====================================================================',
        'ISTRUZIONI DI QUALITA` (mode=ultra):',
        'Per OGNI testo qui sotto, prima di rispondere fai mentalmente:',
        '  1. CONTESTO  → in che tag appare (h1/p/button/li/...)? quale ruolo persuasivo?',
        '                 (hook, proof, scarcity, CTA, objection-handling, social-proof, FAQ, footer...)',
        '  2. TECNICA   → quale framework di copywriting (PAS / AIDA / Big Idea / Story Brand /',
        '                 Schwartz awareness levels) e quale leva (scarcity / authority /',
        '                 social-proof / loss-aversion) e\' piu\' adatta a QUESTO testo?',
        '  3. ARCHIVIO  → cerca nei tuoi archivi prodotti / KB / past work hook o claim simili',
        '                 che hanno convertito. Riusali se calzano.',
        '  4. CANDIDATI → genera 3 rewrite differenti (angle differenti).',
        '  5. PICK BEST → scegli quella che converte di piu\' per QUESTO target,',
        '                 NON quella che suona meglio in astratto.',
        '  6. ANTI-ECO  → rileggi: se la finale parafrasa l\'originale, scartala e usa la #2.',
        'POI ritorna SOLO il JSON con il risultato finale (no preamboli, no ragionamento).',
        '====================================================================',
        '',
      ].join('\n');
    }
    if (REWRITE_QUALITY_MODE === 'high') {
      return [
        '',
        '*** QUALITY MODE = HIGH ***',
        'Per OGNI testo: PRIMA di rispondere, mentalmente genera 2-3 candidate rewrites usando',
        'angle/leve/framework diversi dai tuoi archivi e skill, poi pick la migliore per il',
        'target. NON dare la prima rewrite che ti viene in mente. NON parafrasare l\'originale.',
        'Ritorna SOLO il JSON finale (no ragionamento).',
        '',
      ].join('\n');
    }
    return '\nRicorda: USA i tuoi archivi prodotti, le tue skill di copywriting e le tue tecniche di persuasione. NON parafrasare l\'originale.\n';
  }
  const qualityBooster = buildQualityBooster();

  async function runBatchOnce(batch, label, extraSystemHint) {
    batchCount++;
    const batchUserMessage = `${beforeJson}\n${JSON.stringify(batch, null, 2)}\n${afterJson}${qualityBooster}`;
    log(`  ▸ Rewrite ${label} (${batch.length} testi, mode=${REWRITE_QUALITY_MODE})`);
    let raw = '';
    try {
      const sys = extraSystemHint
        ? `${systemPrompt}\n\nNOTA EXTRA: ${extraSystemHint}`
        : systemPrompt;
      raw = await callOpenClaw([
        { role: 'system', content: sys },
        { role: 'user', content: batchUserMessage },
      ]);
    } catch (e) {
      err(`  ✗ ${label} failed:`, e.message);
      return { added: 0, parsed: 0 };
    }
    const rewrites = extractRewritesFromAiResponse(raw);
    let added = 0;
    for (const rw of rewrites) {
      if (!rw || typeof rw.id !== 'number') continue;
      if (typeof rw.rewritten !== 'string') continue;
      const trimmed = rw.rewritten.trim();
      if (!trimmed) continue;
      // Reject "echo": se il modello restituisce identico all'originale e il
      // testo non e' breve/strutturale, non lo registriamo cosi' verra' ritentato
      // nel pass di echo-fill.
      const original = idToOriginal.get(rw.id);
      if (original && trimmed === original && original.length > 20) {
        continue;
      }
      // Solo se non avevamo gia' una rewrite buona per questo id, oppure se
      // la nuova e' chiaramente migliore (== piu' diversa dall'originale).
      const prev = idToRewrite.get(rw.id);
      if (!prev || prev === original) {
        idToRewrite.set(rw.id, trimmed);
        added++;
      }
    }
    return { added, parsed: rewrites.length };
  }

  // runBatch con auto-split: se il batch ritorna < 70% dei testi attesi
  // (o il JSON e' rotto), spezza in due meta' e riprova ogni meta'
  // separatamente. Cosi' non perdiamo MAI un intero batch per un singolo
  // id rotto / un newline messo male nel JSON dal modello.
  async function runBatch(batch, label, extraSystemHint) {
    if (batch.length === 0) return;
    const expected = batch.filter((t) => t && typeof t.id === 'number').length;
    const beforeSize = idToRewrite.size;
    const result = await runBatchOnce(batch, label, extraSystemHint);
    const newlyCovered = idToRewrite.size - beforeSize;
    // Se ne abbiamo coperti almeno il 70%, OK.
    if (expected === 0 || newlyCovered >= Math.ceil(expected * 0.7)) return;
    // Altrimenti split-and-retry. Solo se batch > 1: con 1 testo non c'e'
    // niente da splittare, ci pensera' il prossimo pass di gap-fill.
    if (batch.length <= 1) return;
    log(
      `  ! ${label}: solo ${newlyCovered}/${expected} coperti (parsed=${result.parsed}). Auto-split in 2 meta'.`,
    );
    const mid = Math.floor(batch.length / 2);
    const half1 = batch.slice(0, mid);
    const half2 = batch.slice(mid);
    await runBatchOnce(half1, `${label}/split-A`, extraSystemHint);
    await runBatchOnce(half2, `${label}/split-B`, extraSystemHint);
  }

  // Pass principale CONCORRENTE.
  // Trinity locale impiega ~30-40s per batch da 5 testi. Su una landing
  // da 100+ testi diventa ~20 min sequenziali. La maggior parte degli
  // LLM gateway locali (OpenClaw, Ollama, vLLM, llama.cpp server) gestisce
  // bene 2-4 richieste in parallelo, quindi fare 3 batch in flight cuts
  // 60-66% del wall-time senza appesantire il modello (e' lo stesso load
  // totale, solo distribuito su time line piu' corta). Configurabile via
  // env per disattivare il parallelismo se il setup locale non lo regge.
  const REWRITE_PARALLELISM = Math.max(
    1,
    Math.min(8, Number.parseInt(process.env.REWRITE_PARALLELISM || '3', 10) || 3),
  );
  const allBatches = [];
  for (let i = 0; i < total; i += REWRITE_BATCH_SIZE) {
    const batch = texts.slice(i, i + REWRITE_BATCH_SIZE);
    const idxFrom = i + 1;
    const idxTo = Math.min(i + REWRITE_BATCH_SIZE, total);
    allBatches.push({ batch, label: `batch ${allBatches.length + 1}/${Math.ceil(total / REWRITE_BATCH_SIZE)} (${idxFrom}-${idxTo}/${total})` });
  }
  log(
    `  ▸ Pass principale: ${allBatches.length} batch totali, ${REWRITE_PARALLELISM} in parallelo`
    + ` (REWRITE_PARALLELISM=${REWRITE_PARALLELISM})`,
  );
  // Worker pool semplice: prendi N batch dalla coda finche' non e' vuota.
  let nextIdx = 0;
  async function consumer() {
    while (nextIdx < allBatches.length) {
      const myIdx = nextIdx++;
      const item = allBatches[myIdx];
      if (!item) break;
      await runBatch(item.batch, item.label);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REWRITE_PARALLELISM, allBatches.length) }, () => consumer()),
  );

  // Gap-fill: il modello locale a volte salta degli id O risponde con echo
  // (= testo originale identico). In entrambi i casi ritentiamo solo i mancanti
  // con un hint di sistema piu' aggressivo e batch sempre piu' piccoli.
  // L'ULTIMO pass usa CHAT-STYLE (call conversazionale 1-a-1, no JSON) —
  // questo bypassa totalmente la pressione "form filler" del JSON e da'
  // la stessa qualita' di quando l'utente chatta direttamente con
  // Neo/Morfeo nel tool. E' la stessa tecnica usata per
  // REWRITE_QUALITY_MODE=chat, ma applicata SOLO ai testi che il
  // modello ha sbagliato/saltato nei pass JSON precedenti.
  const { productName: pName, context: pContext } = extractProductContextFromSystemPrompt(systemPrompt);
  const langMatch = systemPrompt.match(/(?:LINGUA|OUTPUT LANGUAGE).*?:\s*([a-zA-Z]+)/i);
  const detectedLang = langMatch ? langMatch[1].toLowerCase().slice(0, 2) : 'it';

  for (let pass = 1; pass <= REWRITE_GAP_FILL_PASSES; pass++) {
    const missing = texts.filter((t) => !idToRewrite.has(t.id));
    if (missing.length === 0) break;
    const isLastPass = pass === REWRITE_GAP_FILL_PASSES;

    // ULTIMO pass = chat-style 1-a-1 (no JSON pressure)
    if (isLastPass) {
      log(
        `  ▸ Gap-fill pass ${pass}/${REWRITE_GAP_FILL_PASSES}: ${missing.length} testi mancanti — uso CHAT-STYLE (conversazionale, no JSON, come la chat del tool)`,
      );
      for (const t of missing) {
        const rewritten = await rewriteOneTextChatStyle({
          id: t.id,
          originalText: t.text,
          tag: t.tag,
          productName: pName,
          productContext: pContext,
          lang: detectedLang,
        });
        if (rewritten) idToRewrite.set(t.id, rewritten);
      }
      continue;
    }

    // Pass intermedi = JSON con batch decrescente + hint progressivo
    let echoHint;
    if (pass === 1) {
      echoHint = 'Hai appena restituito il testo originale identico per QUESTI id (oppure non li hai inclusi nel JSON). È vietato. Riscrivili davvero per il prodotto target, usando archivi/skill/tecniche.';
    } else {
      echoHint = `Pass ${pass}: gli id qui sotto NON sono ancora stati riscritti. Per OGNI id produci un "rewritten" diverso dall'"text", piu' specifico per il prodotto target. Includi TUTTI gli id nella risposta.`;
    }
    const fillBatchSize = Math.max(2, Math.floor(REWRITE_BATCH_SIZE / (pass + 1)));
    log(
      `  ▸ Gap-fill pass ${pass}/${REWRITE_GAP_FILL_PASSES}: ${missing.length} testi ancora mancanti — batch=${fillBatchSize}`,
    );
    for (let i = 0; i < missing.length; i += fillBatchSize) {
      const slice = missing.slice(i, i + fillBatchSize);
      await runBatch(slice, `gap-fill p${pass} (${slice.length} testi)`, echoHint);
    }
  }

  // Diagnostica pre-fallback: quanti id sono "veri" rewrite vs quanti restano
  // identici all'originale (= il modello ha rifiutato di riscriverli anche
  // dopo tutti i pass). Cosi' nei log si vede chiaramente "X testi non
  // riscritti", che e' il sintomo che vede l'utente nella UI ("saltano testi").
  let trueRewrites = 0;
  let echoFromRetry = 0;
  for (const [id, rewritten] of idToRewrite) {
    const original = idToOriginal.get(id);
    if (original && rewritten.trim() === original) echoFromRetry++;
    else trueRewrites++;
  }

  // Final fallback: per i testi che dopo tutti i pass restano senza rewrite,
  // li includiamo comunque nel response con `rewritten = original` così almeno
  // applyRewrites server-side ha una entry per ogni id (e lo status route può
  // contarli). Senza questo, alcuni testi resterebbero `missing` per sempre.
  let neverTouched = 0;
  for (const t of texts) {
    if (!idToRewrite.has(t.id) && idToOriginal.has(t.id)) {
      idToRewrite.set(t.id, idToOriginal.get(t.id));
      neverTouched++;
    }
  }

  const allRewrites = [];
  for (const [id, rewritten] of idToRewrite) {
    allRewrites.push({ id, rewritten });
  }
  const skippedTotal = neverTouched + echoFromRetry;
  log(
    `  ▸ Rewrite done: ${trueRewrites}/${total} testi VERAMENTE riscritti, ${skippedTotal}/${total} restano = originale`
    + ` (${neverTouched} mai toccati, ${echoFromRetry} echi non risolti) — ${batchCount} batch totali`,
  );
  if (skippedTotal > 0 && skippedTotal / total > 0.15) {
    log(
      `  ! Attenzione: ${Math.round((skippedTotal / total) * 100)}% dei testi NON e' stato riscritto. Se il numero e' alto:`
      + '\n     - prova REWRITE_QUALITY_MODE=high (batch piu\' piccoli)'
      + '\n     - o REWRITE_QUALITY_MODE=ultra (1 testo alla volta, max copertura)'
      + '\n     - o aumenta REWRITE_GAP_FILL_PASSES (default 4)',
    );
  }
  return JSON.stringify(allRewrites);
}

// ===== MESSAGE PROCESSING =========================================
async function processMessage(msg) {
  const isSwipeJob = msg.section === 'swipe_job';
  const preview = String(msg.user_message || '').substring(0, 60).replace(/\n/g, ' ');
  log(`Processing #${msg.id} [${msg.section || 'chat'}]: "${preview}..."`);

  try {
    await supabase
      .from('openclaw_messages')
      .update({ status: 'processing' })
      .eq('id', msg.id);

    const started = Date.now();
    let responsePayload;

    if (isSwipeJob) {
      // ─── SWIPE JOB ──────────────────────────────────────────────────
      // user_message is a JSON-encoded job payload: { action, ...params }
      let job;
      try { job = JSON.parse(msg.user_message); }
      catch { throw new Error('Invalid swipe_job payload (not valid JSON)'); }

      if (!job.action) throw new Error('swipe_job missing action');
      log(`  ▸ Action: ${job.action}`);

      switch (job.action) {
        case 'swipe_landing_page': {
          const result = await callToolApi('/api/landing/swipe', {
            source_url: job.source_url,
            product: job.product,
            tone: job.tone || 'professional',
            language: job.language || 'it',
          }, SWIPE_JOB_TIMEOUT_MS);
          responsePayload = JSON.stringify(result);
          break;
        }
        case 'clone_funnel': {
          const result = await callToolApi('/api/clone-funnel', {
            url: job.url,
            cloneMode: job.cloneMode || 'identical',
            viewport: job.viewport || 'desktop',
            keepScripts: job.keepScripts || false,
          }, SWIPE_JOB_TIMEOUT_MS);
          responsePayload = JSON.stringify(result);
          break;
        }
        case 'agentic_swipe': {
          const result = await callToolApi('/api/agentic-swipe', job.params || {}, SWIPE_JOB_TIMEOUT_MS);
          responsePayload = JSON.stringify(result);
          break;
        }
        case 'invoke_api': {
          // Generic escape hatch: allow MCP to enqueue any tool API call
          if (!job.path) throw new Error('invoke_api job missing path');
          const result = await callToolApi(job.path, job.body || {}, job.timeoutMs || SWIPE_JOB_TIMEOUT_MS);
          responsePayload = JSON.stringify(result);
          break;
        }
        case 'clone_landing_local': {
          // ── Worker-driven clone-landing ─────────────────────────────
          // Mirrors the new checkpoint pattern: heavy page fetch happens
          // HERE on the user's PC (no Netlify timeout, no edge 504),
          // then a single ~1-2s POST to /openclaw-finalize for the
          // CPU-only post-processing (asset rewrite + asset inlining).
          //
          // Job payload:
          //   { action: 'clone_landing_local', url, removeScripts? }
          // Response (JSON-encoded into openclaw_messages.response):
          //   The same shape /api/landing/clone returns on success, so
          //   the existing UI can consume either path interchangeably.
          if (!job.url) throw new Error('clone_landing_local missing url');
          log(`  · clone_landing_local: fetching ${job.url} locally`);
          const fetched = await fetchCheckpointPageHtml(job.url);
          if (!fetched.ok || !fetched.html) {
            throw new Error(
              `Local fetch failed: ${fetched.error || 'no HTML returned'}`,
            );
          }
          log(`    ✓ fetched ${fetched.html.length} chars via ${fetched.source} in ${(fetched.durationMs / 1000).toFixed(1)}s — finalising server-side`);
          const finalised = await callToolApi(
            '/api/landing/clone/openclaw-finalize',
            {
              url: job.url,
              html: fetched.html,
              removeScripts: job.removeScripts,
              methodUsed: fetched.source ? `openclaw-local-${fetched.source}` : 'openclaw-local',
              wasSpa:
                fetched.source === 'playwright-spa' ||
                fetched.source === 'playwright-only',
              attempts: fetched.source ? [fetched.source] : [],
              fetchDurationMs: fetched.durationMs,
            },
            120_000,
          );
          if (finalised && finalised.success === false) {
            throw new Error(finalised.error || 'openclaw-finalize returned failure');
          }
          responsePayload = JSON.stringify(finalised);
          break;
        }
        case 'swipe_landing_local': {
          // ── Worker-driven landing swipe ─────────────────────────────
          // Three Netlify round-trips, each guaranteed sub-2s. The slow
          // bits live HERE on the user's PC:
          //   • optional Playwright fetch of the source page
          //   • LLM rewrite loop (batched + gap-fill) via local
          //     OpenClaw / Trinity / whatever the worker is wired to
          //
          // Job payload:
          //   { action: 'swipe_landing_local',
          //     html?, sourceUrl?, product, tone?, language? }
          // Either html OR sourceUrl is required. The UI normally
          // ships `html` because it has the clone result already; MCP
          // / curl callers can pass sourceUrl to fetch fresh.
          //
          // Response (JSON-encoded into openclaw_messages.response):
          //   Same shape /api/landing/swipe returns on success — the
          //   existing handleSwipe in clone-landing/page.tsx eats it
          //   without modifications.
          if (!job.product || !job.product.name) {
            throw new Error('swipe_landing_local missing product.name');
          }
          let originalHtml = typeof job.html === 'string' ? job.html : '';
          if (!originalHtml) {
            if (!job.sourceUrl) {
              throw new Error('swipe_landing_local: provide either html or sourceUrl');
            }
            log(`  · swipe_landing_local: fetching ${job.sourceUrl} locally`);
            const fetched = await fetchCheckpointPageHtml(job.sourceUrl);
            if (!fetched.ok || !fetched.html) {
              throw new Error(
                `Local fetch failed: ${fetched.error || 'no HTML returned'}`,
              );
            }
            originalHtml = fetched.html;
            log(`    ✓ fetched ${originalHtml.length} chars via ${fetched.source} in ${(fetched.durationMs / 1000).toFixed(1)}s`);
          }

          // 1. Build prompts (extract texts + system prompt + user message
          //    pre-formatted with the markers runRewriteInBatches expects).
          // Forwarda anche `knowledge` (libreria saved_prompts dell'utente
          // + brief progetto): server-side la embed nel system prompt cosi'
          // Neo/Morfeo ricevono tecniche+brief insieme al testo.
          // ── KNOWLEDGE: usata se passata, altrimenti l'agente la
          // tirera' fuori da SOLO dai suoi archivi nel primer step.
          // Nessun blocco qui: e' compito del primer chiedere a Neo/
          // Morfeo di consultare i loro archivi per brief + MR + tecniche.
          const projForCheck = job.knowledge?.project || null;
          const hasBriefForCheck = !!(projForCheck?.brief && String(projForCheck.brief).trim().length > 30);
          const mrForCheck = projForCheck?.market_research;
          const hasMRForCheck =
            !!mrForCheck &&
            ((typeof mrForCheck === 'string' && mrForCheck.trim().length > 30) ||
              (typeof mrForCheck === 'object' && Object.keys(mrForCheck || {}).length > 0));
          const pCount = job.knowledge?.prompts?.length || 0;
          const projName = projForCheck?.name || '(non specificato)';
          const briefLen = projForCheck?.brief ? String(projForCheck.brief).length : 0;
          const mrLen = (() => {
            if (typeof mrForCheck === 'string') return mrForCheck.length;
            if (mrForCheck) {
              try { return JSON.stringify(mrForCheck).length; } catch { return 0; }
            }
            return 0;
          })();
          if (hasBriefForCheck && hasMRForCheck) {
            log(`  · swipe_landing_local: knowledge dal tool OK — ${pCount} tecniche + brief "${projName}" (${briefLen} char) + MR (${mrLen} char)`);
          } else {
            const missing = [];
            if (!hasBriefForCheck) missing.push('brief');
            if (!hasMRForCheck) missing.push('market research');
            log(`  · swipe_landing_local: knowledge dal tool parziale — ${pCount} tecniche libreria, manca ${missing.join('+')}. Chiedero' all'agente di tirarli fuori dai SUOI archivi nel primer.`);
          }
          // 0.5 — BUNDLE JS EXTRACTION (Next.js CSR-only quiz/funnel).
          // Per pagine come Bioma Health i veri testi (domande quiz, opzioni,
          // CTA, headline) sono hardcoded dentro /_next/static/chunks/pages/*.js
          // e NON sono ne' nell'HTML SSR ne' in __NEXT_DATA__. Li scarichiamo
          // qui in parallelo cosi' poi finiscono nel batch di rewrite insieme
          // agli altri testi. Best-effort: errori non bloccano lo swipe.
          let extraTexts = [];
          try {
            extraTexts = await extractBundleTexts(originalHtml, job.sourceUrl, {
              log: (m) => log(m),
              warn: (m) => err(m),
            });
            if (extraTexts.length > 0) {
              log(`  · swipe_landing_local: +${extraTexts.length} testi dai bundle JS Next.js`);
            }
          } catch (e) {
            err(`  · bundle-extractor: skipped per errore non fatale: ${e.message}`);
            extraTexts = [];
          }

          log(`  · swipe_landing_local: building prompts IN-PROCESS (no Netlify)`);
          let prep;
          try {
            prep = buildSwipePrompts({
              html: originalHtml,
              sourceUrl: job.sourceUrl,
              product: job.product,
              tone: job.tone,
              language: job.language,
              knowledge: job.knowledge || undefined,
              extraTexts: extraTexts.length > 0 ? extraTexts : undefined,
            });
          } catch (e) {
            throw new Error(`build-prompts (in-process) fallito: ${e.message}`);
          }
          const promptTexts = Array.isArray(prep.texts) ? prep.texts : [];
          if (promptTexts.length === 0) {
            throw new Error('No texts to rewrite (page had no extractable copy)');
          }
          if (prep.knowledgeIncluded) {
            const k = prep.knowledgeIncluded;
            log(`    · prompts pronti: ${promptTexts.length} testi, KB built-in ${k.builtinKbChars} char, ${k.promptCount} tecniche libreria, brief=${k.projectBriefChars} char, MR=${k.marketResearchChars} char`);
          }
          if (prep.productFacts && prep.productFacts.sheetChars > 0) {
            const f = prep.productFacts;
            const summary = [];
            if (f.doctors.length) summary.push(`dottori=[${f.doctors.join(', ')}]`);
            if (f.durations.length) summary.push(`durate=[${f.durations.join(', ')}]`);
            if (f.guarantees.length) summary.push(`garanzie=[${f.guarantees.join(', ')}]`);
            if (f.percentages.length) summary.push(`%=[${f.percentages.join(', ')}]`);
            if (f.ingredientsCount) summary.push(`ingredienti=${f.ingredientsCount}`);
            if (f.hasPrice) summary.push('prezzo=ok');
            log(`    · 🎯 PRODUCT FACTS cheat-sheet (${f.sheetChars} char): ${summary.length ? summary.join(' · ') : '(solo nome prodotto)'}`);
          } else {
            log(`    · ⚠️  PRODUCT FACTS cheat-sheet vuota: il LLM non potra' fare fact-substitution automatica. Verifica che il brief contenga dottori/durate/prezzi/garanzie.`);
          }
          log(`  · swipe_landing_local: rewriting ${promptTexts.length} texts via local LLM (batched)`);

          // 1.5 — LOCAL MEMORY PRIMER ─────────────────────────────────
          // Prima del rewrite chiediamo all'LLM locale di consultare la
          // SUA memoria (conversazioni passate, knowledge base, file di
          // progetto, esperienze pregresse) e tirare fuori tutto quello
          // che ricorda e che possa migliorare il copy. Il risultato lo
          // appendiamo al systemPrompt che gira a runRewriteInBatches,
          // cosi' il contesto extra arriva a OGNI batch a costo di una
          // sola chiamata LLM (non per batch).
          //
          // Se l'LLM non ha memoria utile o la chiamata fallisce,
          // procediamo comunque col system prompt originale — tutto
          // best-effort. NON facciamo fallire il job per questo.
          let enrichedSystemPrompt = prep.systemPrompt;

          // (a) Static extra context — knowledge personale messa
          //     dall'utente sul filesystem del worker. Iniettata sempre,
          //     a prescindere dal primer LLM.
          if (STATIC_EXTRA_CONTEXT) {
            enrichedSystemPrompt = `${enrichedSystemPrompt}\n\n=== KNOWLEDGE STATICA (${path.basename(STATIC_EXTRA_CONTEXT.path)}, USALA ATTIVAMENTE) ===\n${STATIC_EXTRA_CONTEXT.content}\n=== FINE KNOWLEDGE STATICA ===`;
            log(`  · swipe_landing_local: static knowledge iniettata (${STATIC_EXTRA_CONTEXT.content.length} chars)`);
          }

          // (b) Live agent primer — chiediamo all'AGENTE locale (NON un
          //     semplice LLM: Neo/Morfeo hanno archivi prodotti, RAG
          //     interna, knowledge base proprietaria, skill specifiche
          //     di copywriting / persuasione / direct response, tecniche
          //     che hanno costruito nel tempo) di andare a pescare TUTTO
          //     cio' che gli serve dalle SUE risorse interne per fare
          //     un rewrite di alto livello.
          //
          //     Costo: 1 chiamata in piu' per swipe (non per batch).
          //     Il risultato viene appeso al system prompt e arriva a
          //     OGNI batch successivo gratis.
          //
          //     SKIP in oneshot mode: oneshot fa gia' 1-3 batch grossi
          //     ciascuno con tutto il system prompt. Aggiungere altri
          //     6-8K char di primer al system prompt fa esplodere il
          //     payload e OpenClaw locale rigetta con ECONNABORTED.
          //     In oneshot l'agente ha gia' tutta la KB built-in +
          //     tecniche utente nel system prompt — il primer e' overhead.
          //     IL PRIMER GIRA SEMPRE — anche in oneshot — perche' e' il
          //     modo con cui chiediamo a Neo/Morfeo di USARE attivamente
          //     i loro archivi interni (Stefan Georgi, Sultanic Frameworks,
          //     Eugene Schwartz, Halbert, Caples, Bencivenga, Ogilvy, Carlton,
          //     Jay Abraham, Dan Kennedy, ecc.) e di internalizzare il
          //     brief + market research del progetto prima di toccare il
          //     copy. Senza questo step l'agente "fa il riassunto" del
          //     testo originale e produce copy generico.
          try {
            // Compatta brief e MR per non esplodere il payload del primer
            // (limite OpenClaw locale ~80K char per request).
            const briefStr = projForCheck?.brief ? String(projForCheck.brief).trim() : '';
            const mrStr = (() => {
              if (!mrForCheck) return '';
              if (typeof mrForCheck === 'string') return mrForCheck.trim();
              try { return JSON.stringify(mrForCheck, null, 2); } catch { return ''; }
            })();
            const briefShort = briefStr.length > 4000 ? briefStr.slice(0, 4000) + '\n[...troncato per limite payload primer...]' : briefStr;
            const mrShort = mrStr.length > 4000 ? mrStr.slice(0, 4000) + '\n[...troncato per limite payload primer...]' : mrStr;

            // Estrai il TESTO PLAIN della landing originale dal HTML. Senza
            // questo, il primer sceglie "big idea" e "leve" al buio (vede solo
            // URL + brief, NON il copy del competitor). Cap a 6K char: oltre
            // esplode il payload del primer (limite OpenClaw ~80K).
            const pagePreview = (() => {
              if (!originalHtml || typeof originalHtml !== 'string') return '';
              const plain = originalHtml
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
                .replace(/<!--[\s\S]*?-->/g, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\s+/g, ' ')
                .trim();
              if (plain.length <= 6000) return plain;
              // Prendi inizio (hook/headline) + finale (offer/cta) — è dove
              // sta la roba persuasiva. Saltiamo il middle (testimonial+modulo
              // lista che spesso è ripetitivo).
              return `${plain.slice(0, 4500)}\n\n[...porzione centrale omessa per limite payload primer...]\n\n${plain.slice(-1500)}`;
            })();

            const productLines = [];
            productLines.push(`PRODOTTO DA PROMUOVERE: ${job.product?.name || projForCheck?.name || '(non fornito — usa il sourceUrl per dedurlo)'}`);
            if (job.product?.description) productLines.push(`DESCRIZIONE FORNITA DAL TOOL:\n${job.product.description}`);
            if (job.sourceUrl) productLines.push(`URL COMPETITOR DA CUI PRENDIAMO STRUTTURA HTML: ${job.sourceUrl}`);
            if (briefShort) productLines.push(`BRIEF FORNITO DAL TOOL (parziale — usa anche il TUO archivio per arricchirlo):\n${briefShort}`);
            else productLines.push('BRIEF FORNITO DAL TOOL: ⚠ NESSUNO. DEVI costruirtelo TU consultando i TUOI archivi prodotti per questo specifico prodotto / settore.');
            if (mrShort) productLines.push(`MARKET RESEARCH FORNITA DAL TOOL (parziale — usa anche il TUO archivio per arricchirla):\n${mrShort}`);
            else productLines.push('MARKET RESEARCH FORNITA DAL TOOL: ⚠ NESSUNA. DEVI costruirtela TU consultando i TUOI dati di mercato storici per questo settore.');
            if (pagePreview) productLines.push(`COPY ORIGINALE DEL COMPETITOR (testo plain estratto, ${pagePreview.length} char — LEGGILO ATTENTAMENTE prima di scegliere big idea/leve: questo e' il flusso narrativo che andrai a sovrascrivere):\n${pagePreview}`);
            const productCtx = productLines.join('\n\n');

            const primerSystem = `Sei un AGENTE direct-response (NON un LLM generico). Hai accesso a:
- Archivi prodotti reali indicizzati nei tuoi sistemi (ingredienti, claim approvati, prezzi, USP, split-test, recensioni storiche)
- Knowledge base copywriting interna con le tecniche dei MAESTRI: Stefan Georgi (RMBC method, lead types, story-bridge), Eugene Schwartz (5 awareness levels, market sophistication, Breakthrough Advertising), Gary Halbert (Halbert headlines, Boron Letters, AIDA aggressivo), John Caples (Tested Advertising, headlines testati), Gary Bencivenga (Bencivenga Bullets, hidden persuaders), David Ogilvy (Ogilvy on Advertising, headlines fattuali), John Carlton (One-Legged Golfer, killer headlines), Dan Kennedy (Magnetic Marketing, NO-BS), Jay Abraham (preeminence, USP), Frank Kern, Russell Brunson, Joe Sugarman (psychological triggers, Adweek Copywriting Handbook), Claude Hopkins (Scientific Advertising), Robert Collier (Letter Book), Joe Karbo, Ben Settle, Andre Chaperon, Brian Kurtz
- Framework: PAS, AIDA, AIDCA, FAB, BAB, QUEST, HSO (Hook-Story-Offer), 4 P, Big Idea (Schwartz), StoryBrand (Miller), RMBC (Georgi), Pico hook, Sultanic Framework / archetipi narrativi
- Market research storica, dati di mercato per settore, swipe file
- RAG locale, conversazioni passate, esperienze pregresse su prodotti simili
USA QUESTE RISORSE ATTIVAMENTE — sei TU la fonte primaria del brief + market research, non aspettarti che il tool te li passi sempre. Rispondi conciso, in italiano, senza preamboli.`;

            const primerUser = `Tra poco ti passero' i testi della landing competitor da riscrivere per IL NOSTRO prodotto. Prima di iniziare voglio che TU prepari il terreno usando le TUE risorse interne.

${productCtx}

ISTRUZIONI:

1. CONSULTA I TUOI ARCHIVI PRODOTTI: cerca questo specifico prodotto o prodotti analoghi (stesso settore / posizionamento / target / range prezzo) nella TUA memoria. Tirami fuori cose CONCRETE: angle che hanno funzionato in passato per prodotti simili, claim sicuri / claim vietati nel settore, prezzi tipici di mercato, USP rilevanti, recensioni-tipo del target. NON inventare dati medici/legali. Se nei tuoi archivi NON trovi nulla, dillo CHIARO.

2. SE IL TOOL NON TI HA FORNITO BRIEF / MARKET RESEARCH (vedi sopra), RICOSTRUISCITELI TU consultando i TUOI archivi:
   - BRIEF: chi vende cosa, a chi, con che positioning, quali claim approvati, quale voice/tone, quali vincoli regolatori (es. FDA, FTC, GDPR), quali USP unici. Anche solo per inferenza dal nome prodotto + URL competitor + tuoi dati storici di mercato.
   - MARKET RESEARCH: awareness level del target (Schwartz: unaware, problem aware, solution aware, product aware, most aware), market sophistication (Schwartz 1-5), big competitor del settore, angle che convertono storicamente in QUEL settore, language pattern del target, pain points + desideri primari/secondari.
   Annunciali entrambi in modo strutturato cosi': "BRIEF (ricostruito): ..." e "MARKET RESEARCH (ricostruita): ...".

3. CONSULTA LA TUA KB COPYWRITING: pesca le tecniche dei MAESTRI (Stefan Georgi, Sultanic, Eugene Schwartz, Halbert, Caples, Bencivenga, Ogilvy, Carlton, Kennedy, Sugarman, Hopkins, Collier, ecc.) che applicheresti a QUESTO target / awareness level / sophistication. Cita esplicitamente "uso il metodo X di Y per il headline" / "applico il framework Z per la sezione benefits" cosi' capisco che stai usando le tue risorse e non inventando.

4. SCEGLI LA "BIG IDEA" CENTRALE che useremo per riscrivere TUTTI i testi della pagina, in modo coerente. UNA sola big idea, declinata in headline, body, CTA. Annunciala con "BIG IDEA: ...".

5. SCEGLI 2-3 LEVE PRINCIPALI (es. fear-of-loss + social-proof + autorita' scientifica) coerenti con awareness level + market sophistication del nostro target. Annunciale con "LEVE: ...".

Restituisci UN SOLO blocco di testo (no markdown enorme, no JSON, no liste numerate gigantesche). Massimo 1500 parole. Vai DIRETTO al sodo: archivi → brief ricostruito → market research ricostruita → tecniche citate per nome → big idea → leve.

ONESTA': se nei TUOI archivi non hai dati su questo prodotto/settore e non puoi costruire brief/MR seri, DILLO CHIARO scrivendo all'inizio "ARCHIVI INSUFFICIENTI: lavorero' solo con tecniche generiche dei maestri + struttura del competitor". Cosi' so cosa aspettarmi.`;

            log(`  · swipe_landing_local: priming agent (${hasBriefForCheck && hasMRForCheck ? 'arricchimento' : 'ricostruzione brief+MR dai SUOI archivi'} + tecniche maestri)…`);
            const memoryDump = await callOpenClaw([
              { role: 'system', content: primerSystem },
              { role: 'user', content: primerUser },
            ]);
            const trimmed = (memoryDump || '').trim();
            if (trimmed.length > 80 && !/^nessun contesto aggiuntivo\.?$/i.test(trimmed)) {
              // Cap difensivo: non vogliamo che il primer faccia esplodere
              // il payload di OGNI batch successivo (ECONNABORTED).
              const primerCapped = trimmed.length > 8000 ? trimmed.slice(0, 8000) + '\n[...primer troncato per limite payload...]' : trimmed;
              enrichedSystemPrompt = `${enrichedSystemPrompt}\n\n=== ANALISI PREP DELL'AGENTE (archivi + tecniche maestri citate + big idea + leve, dal primer su questo prodotto) ===\n${primerCapped}\n=== FINE ANALISI PREP ===\n\nIMPORTANTE: nei rewrite che seguono, APPLICA la big idea + le leve scelte qui sopra, e USA le tecniche dei maestri che hai citato. Niente parafrasi del competitor — ogni testo deve riflettere LA NOSTRA big idea coerente.`;
              log(`    ✓ agent primer: ${primerCapped.length} chars di analisi (Stefan Georgi/Sultanic/etc + brief/MR internalizzati) iniettati nel system prompt`);
              log(`    ► primer preview (primi 800 char): ${primerCapped.slice(0, 800).replace(/\n/g, ' | ')}${primerCapped.length > 800 ? '...' : ''}`);
            } else {
              log('    ⚠ agent primer: risposta troppo corta o vuota — il system prompt usera\' solo brief/MR senza analisi prep');
            }
          } catch (e) {
            log(`    ⚠ agent primer FALLITO (${e.message}) — vado avanti col system prompt base, ma la qualita' sara\' inferiore`);
          }

          // 2. Run the batched rewrite against the local LLM.
          //    runRewriteInBatches auto-detects the markers we used in
          //    the user_message and does batching + gap-fill internally.
          const rewriteRaw = await runRewriteInBatches(enrichedSystemPrompt, prep.userMessage);
          let rewrites = [];
          try {
            const cleaned = String(rewriteRaw).trim()
              .replace(/^```(?:json)?\s*\n?/i, '')
              .replace(/\n?```\s*$/i, '');
            const a = cleaned.indexOf('[');
            const b = cleaned.lastIndexOf(']');
            if (a >= 0 && b > a) {
              rewrites = JSON.parse(cleaned.substring(a, b + 1));
            }
          } catch (e) {
            err(`  ✗ Failed to parse local LLM rewrite response: ${e.message}`);
          }
          if (!Array.isArray(rewrites) || rewrites.length === 0) {
            throw new Error('Local LLM did not return any usable rewrites');
          }
          log(`    ✓ got ${rewrites.length}/${promptTexts.length} rewrites from local LLM`);

          // 3. Finalise IN-PROCESS: applichiamo i rewrite all'HTML
          //    qui dentro al worker, ZERO chiamate HTTP. Il risultato
          //    finale viene scritto su Supabase via responsePayload.
          log(`  · swipe_landing_local: finalising IN-PROCESS (apply mappings + inject script)`);
          let finalised;
          try {
            finalised = finalizeSwipeLocal({
              html: originalHtml,
              sourceUrl: job.sourceUrl,
              texts: promptTexts,
              rewrites,
              // Necessario per: (a) brand replace dal dominio del competitor
              // (es. "nooro" → productName), (b) collapse anti-stuffing
              // ("Reset Patch Reset Patch" → "Reset Patch"). Si veda
              // worker-lib/finalize.js #replaceBrandInHtml.
              productName: job.product?.name || '',
              // Auto-on per pagine SPA: strippa <script>/<noscript>/on*
              // originali e inietta nav-fix Next.js + FAQ CSS hard-override
              // + fallback init (jQuery/Swiper da CDN, FAQ accordion delegato,
              // thumb→main image). Cosi' il preview e' interattivo anche
              // quando il bundle originale fallisce a montare. Opt-out
              // possibile passando false esplicitamente.
              applySpaPreviewMode: job.applySpaPreviewMode,
            });
          } catch (e) {
            throw new Error(`finalize (in-process) fallito: ${e.message}`);
          }
          // BUNDLE INLINING: per ogni testo js-bundle riscritto, rifa la
          // fetch del bundle, sostituisce le stringhe, e inline-a il bundle
          // modificato al posto del <script src> originale. Cosi' i quiz
          // CSR-only mostrano i testi riscritti. Best-effort: errori non
          // bloccano la response.
          const hasBundleTexts = promptTexts.some((t) => t.tag === 'js-bundle');
          if (hasBundleTexts) {
            try {
              const inlined = await inlineBundleRewrites(
                { html: finalised.html, texts: promptTexts, rewrites },
                { log: (m) => log(m), warn: (m) => err(m) },
              );
              finalised.html = inlined.html;
              finalised.new_length = inlined.html.length;
              finalised.bundle_inline_stats = inlined.stats;
              log(`    ✓ bundle inlining: ${inlined.stats.bundlesInlined}/${inlined.stats.bundlesAttempted} bundle, ${inlined.stats.totalReplacements} stringhe`);
            } catch (e) {
              err(`  · bundle-inliner: skipped per errore non fatale: ${e.message}`);
              finalised.bundle_inline_stats = { error: e.message };
            }
          }
          log(`    ✓ swipe done: ${finalised.replacements}/${finalised.totalTexts} replacements, ${finalised.unresolved_text_ids?.length || 0} unresolved` +
            (finalised.is_spa_page ? ` (SPA: ${finalised.spa_safety_strips} strips, preview-mode=${finalised.spa_preview_mode_applied})` : ''));
          responsePayload = JSON.stringify(finalised);
          break;
        }
        default:
          throw new Error(`Unknown swipe_job action: ${job.action}`);
      }
    } else if (msg.section === 'checkpoint_audit') {
      // ─── CHECKPOINT AUDIT (qualitative funnel audit, multi-step) ───
      // Payload (in user_message, JSON-encoded):
      //   v1 payload (legacy):
      //     { runId, funnelId, prompts: [{category, system, user}, ...] }
      //   v2 payload (current):
      //     { runId, funnelId, categories: [...], brandProfile? }
      //
      // In v2 the server enqueues fast (no page fetch, no prompt build)
      // and we ask /api/checkpoint/[funnelId]/openclaw-prep here for
      // pre-built prompts. This moves the slow Playwright work out of
      // the user-facing POST so the dashboard never sees a 504.
      // Per-category errors don't abort the run — we mark the offending
      // category as 'error' and keep going (matches Claude pipeline).
      let payload;
      try { payload = JSON.parse(msg.user_message); }
      catch { throw new Error('Invalid checkpoint_audit payload (not valid JSON)'); }

      const { runId, funnelId, categories, brandProfile } = payload;
      log(`  · checkpoint_audit payload: runId=${runId || '(missing)'} funnelId=${funnelId || '(missing)'} categories=${Array.isArray(categories) ? categories.join(',') : '(missing)'}`);
      if (!runId) throw new Error('checkpoint_audit missing runId');

      // The categories the run was enqueued with — used as the
      // "expected" set for openclaw-finalize (so the server can
      // mark any never-reported category as `error` instead of
      // leaving the dashboard column on "In attesa di analisi…").
      // Falls back to whatever the server's default category set
      // is when the payload omits it (older /run versions).
      const requestedCategories = Array.isArray(categories) && categories.length > 0
        ? categories
        : ['navigation', 'coherence', 'copy', 'cro'];

      let prompts = Array.isArray(payload.prompts) ? payload.prompts : null;
      if (!prompts) {
        if (!funnelId) {
          // Don't just throw — also tell the server so the run
          // doesn't sit on `running` forever. The catch at the
          // bottom of this block handles other crashes the same
          // way, but this one fires before we have anything to
          // pass to it.
          await callToolApi(
            `/api/checkpoint/runs/${runId}/openclaw-finalize`,
            {
              status: 'failed',
              error: 'checkpoint_audit payload was missing funnelId — worker probably running an old version. Stop the worker, `git pull`, restart with `node openclaw-worker.js`.',
              expectedCategories: requestedCategories,
            },
            60_000,
          ).catch(() => {});
          throw new Error('checkpoint_audit missing funnelId (and no prompts inline)');
        }
        log(`  · prep: fetching funnel info from server (light read)`);
        // ── New flow ────────────────────────────────────────────────
        // The slow Playwright/SPA fetch is now done LOCALLY here.
        // Only two server calls remain in this hot path and both are
        // guaranteed sub-second:
        //   1) GET /api/checkpoint/[id]   → funnel + pages metadata
        //   2) POST /openclaw-build-prompts → text → prompts
        // Anything that used to fail with a Netlify 504 ("Inactivity
        // Timeout" after ~28s during page fetch) now lives on the
        // user's PC where there is no inactivity timeout at all.
        let prep;
        try {
          // 1. Funnel metadata (pages array, brand profile, name).
          const funnelInfo = await callToolApi(
            `/api/checkpoint/${funnelId}`,
            null,
            30_000,
            'GET',
          );
          if (!funnelInfo || !funnelInfo.funnel) {
            throw new Error('Funnel not found on server');
          }
          const funnelPages = Array.isArray(funnelInfo.funnel.pages)
            ? funnelInfo.funnel.pages
            : [];
          if (funnelPages.length === 0) {
            throw new Error('Funnel has no pages configured');
          }

          // 2. Local fetch of every page (Playwright on this PC) + a
          //    progress hint into funnel_checkpoints.error so the
          //    dashboard's live monitor shows "Pagine scaricate X/N".
          log(`  · fetching ${funnelPages.length} pages locally (Playwright)…`);
          await writeCheckpointStageHint(runId, `Scarico ${funnelPages.length} pagine in locale…`);
          const auditSteps = await fetchCheckpointFunnelLocally(funnelPages, {
            onProgress: async (done, total) => {
              await writeCheckpointStageHint(
                runId,
                `Pagine scaricate ${done}/${total} (worker locale)`,
              );
            },
          });
          const reachableNow = auditSteps.filter(
            (s) => s.pageText && s.pageText.length > 0,
          ).length;
          log(`  · local fetch done: ${reachableNow}/${auditSteps.length} pages reachable`);
          await writeCheckpointStageHint(
            runId,
            `Costruzione prompt (${reachableNow}/${auditSteps.length} pagine pronte)…`,
          );

          // 3. Build prompts on the server. Tiny payload by checkpoint
          //    standards: ~25KB per page after htmlToAuditText, well
          //    inside Netlify's 6MB POST limit even on funnels with
          //    25 steps.
          prep = await callToolApi(
            `/api/checkpoint/${funnelId}/openclaw-build-prompts`,
            { categories, brandProfile, auditSteps },
            60_000,
          );
          if (prep && typeof prep === 'object' && prep.error) {
            throw new Error(String(prep.error));
          }
        } catch (e) {
          err(`  ✗ openclaw prep (local) failed: ${e.message}`);
          await callToolApi(
            `/api/checkpoint/runs/${runId}/openclaw-finalize`,
            {
              status: 'failed',
              error: `Prep step failed: ${e.message}`,
              expectedCategories: requestedCategories,
            },
            60_000,
          ).catch(() => {});
          throw e;
        }
        prompts = prep.prompts || [];
        log(`  · prep done: ${prep.reachableCount}/${prep.pageCount} pages reachable, ${prompts.length} prompts ready, ${prep.skipped?.length || 0} skipped`);

        // Persist the "skipped" categories the prep step couldn't run.
        for (const sk of prep.skipped || []) {
          await callToolApi(
            `/api/checkpoint/runs/${runId}/openclaw-category`,
            {
              category: sk.category,
              ok: false,
              error: sk.reason,
              skipped: true,
            },
            30_000,
          ).catch((e) => err(`  · skip persist failed: ${e.message}`));
        }
      }

      // The list of categories we EXPECTED to deliver — sent to the
      // finaliser so the server can fill any "lost" category as
      // `error` if our POST to /openclaw-category never landed (eg
      // network blip). Without this, a silently-dropped category
      // would leave the dashboard column stuck on "In attesa di
      // analisi…" even on a "completed" run.
      const expectedCategories = prompts.map((p) => p.category);

      if (prompts.length === 0) {
        // Nothing to ask the model — finalise as completed (skipped-only).
        await callToolApi(
          `/api/checkpoint/runs/${runId}/openclaw-finalize`,
          { status: 'completed', expectedCategories },
          60_000,
        );
        responsePayload = JSON.stringify({ runId, ok: 0, errored: 0, total: 0, status: 'completed' });
      } else {
        const summary = { ok: 0, errored: 0, total: prompts.length };
        for (let i = 0; i < prompts.length; i++) {
          const p = prompts[i];
          const cat = p.category;
          const catStarted = Date.now();
          log(`  ▸ checkpoint ${cat} (${i + 1}/${prompts.length})`);
          // Surface "we're working on category X" to the dashboard's
          // live monitor. Without this hint, when a category crashed
          // AND the follow-up POST below also failed, the user saw
          // nothing between the previous category's success event and
          // the run-level "completata parzialmente" badge — total
          // black hole. The hint guarantees AT LEAST one event per
          // category attempt, regardless of POST outcome.
          await writeCheckpointStageHint(
            runId,
            `Categoria ${cat} (${i + 1}/${prompts.length}) · analisi in corso…`,
          );
          try {
            _callContext = {
              source: 'checkpoint_audit',
              metadata: { runId, funnelId, category: cat },
            };
            const reply = await callOpenClaw([
              { role: 'system', content: p.system },
              { role: 'user', content: p.user },
            ]);
            _callContext = null;
            await callToolApi(
              `/api/checkpoint/runs/${runId}/openclaw-category`,
              { category: cat, reply, ok: true },
              120_000,
            );
            summary.ok++;
            log(`    ✓ ${cat} ok in ${((Date.now() - catStarted) / 1000).toFixed(1)}s`);
          } catch (e) {
            err(`  ✗ checkpoint ${cat} failed in ${((Date.now() - catStarted) / 1000).toFixed(1)}s:`, e.message);
            // Try to surface the error to the dashboard. If THIS POST
            // also fails (it's the same Netlify endpoint that may be
            // down), don't crash the whole loop — but DO log the
            // secondary failure loud and clear in the worker
            // terminal. Previously this was a silent .catch(noop)
            // and the user had no way to tell whether the worker
            // skipped the category or just couldn't tell the server
            // about it.
            try {
              await callToolApi(
                `/api/checkpoint/runs/${runId}/openclaw-category`,
                { category: cat, ok: false, error: e.message },
                60_000,
              );
            } catch (postErr) {
              err(
                `  ⚠ ALSO failed to report ${cat} failure to server:`,
                postErr && postErr.message ? postErr.message : String(postErr),
              );
              // Best-effort stage hint so the dashboard at least
              // shows an event marker tied to this category.
              await writeCheckpointStageHint(
                runId,
                `Categoria ${cat} · errore non riportato al server (${e.message?.slice(0, 80) || 'ignoto'})`,
              );
            }
            summary.errored++;
          }
        }

        const finalStatus =
          summary.ok === 0 ? 'failed' : summary.errored === 0 ? 'completed' : 'partial';
        await callToolApi(
          `/api/checkpoint/runs/${runId}/openclaw-finalize`,
          { status: finalStatus, expectedCategories },
          60_000,
        );
        responsePayload = JSON.stringify({ runId, ...summary, status: finalStatus });
      }
    } else if (isRewriteSection(msg.section)) {
      // ─── REWRITE JOB (Trinity quiz-rewrite) ────────────────────────
      // Splittiamo in batch per non far esplodere il context del modello.
      const systemPrompt = msg.system_prompt || '';
      responsePayload = await runRewriteInBatches(systemPrompt, msg.user_message || '');
    } else {
      // ─── CHAT MESSAGE (existing behavior) ───────────────────────────
      const systemPrompt = msg.system_prompt
        || 'You are OpenClaw, an AI assistant. Be concise and helpful. Respond in the same language as the user.';
      const messages = [{ role: 'system', content: systemPrompt }];

      let history = [];
      try {
        if (msg.chat_history) {
          history = typeof msg.chat_history === 'string'
            ? JSON.parse(msg.chat_history)
            : msg.chat_history;
        }
      } catch { /* ignore malformed history */ }
      if (Array.isArray(history) && history.length > 0) {
        history.forEach(h => messages.push({ role: h.role, content: h.content }));
      }
      messages.push({ role: 'user', content: msg.user_message });

      responsePayload = await callOpenClaw(messages);
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    await supabase
      .from('openclaw_messages')
      .update({
        status: 'completed',
        response: responsePayload,
        completed_at: new Date().toISOString(),
      })
      .eq('id', msg.id);

    totalProcessed++;
    log(`✅ Completed #${msg.id} in ${elapsed}s (${(responsePayload || '').length} chars, total processed: ${totalProcessed})`);
  } catch (e) {
    totalErrors++;
    err(`#${msg.id}:`, e.message);
    try {
      await supabase
        .from('openclaw_messages')
        .update({
          status: 'error',
          error_message: e.message.substring(0, 500),
          completed_at: new Date().toISOString(),
        })
        .eq('id', msg.id);
    } catch (updateErr) {
      err(`Failed to mark #${msg.id} as error:`, updateErr.message);
    }
  }
}

// ===== POLL LOOP ==================================================
async function poll() {
  if (isProcessing) return; // skip if still busy
  isProcessing = true;

  try {
    // Filter so that ONLY rows targeted at this worker (or untargeted
    // legacy rows) are claimed. Without this, with two workers running
    // (Neo + Morfeo) the queue is first-come-first-served and the user
    // can't choose which agent processes a job.
    //
    // - OPENCLAW_AGENT === null  → legacy mode (no filter, picks any).
    // - OPENCLAW_AGENT === 'openclaw:neo' → only Neo's targeted jobs
    //   PLUS any untagged jobs (back-compat for queue consumers that
    //   still don't set target_agent — keeps chat / rewrite / swipe
    //   working unchanged).
    let pollQuery = supabase
      .from('openclaw_messages')
      .select('*')
      .eq('status', 'pending');
    if (OPENCLAW_AGENT) {
      pollQuery = pollQuery.or(
        `target_agent.is.null,target_agent.eq.${OPENCLAW_AGENT}`,
      );
    }
    const { data, error } = await pollQuery
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      consecutivePollErrors++;
      err(`Poll error (${consecutivePollErrors}/${MAX_CONSECUTIVE_POLL_ERRORS}):`, error.message);
      if (consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        err('Too many consecutive poll errors. Exiting so service manager can restart us.');
        process.exit(1);
      }
      return;
    }

    consecutivePollErrors = 0;

    if (data && data.length > 0) {
      await processMessage(data[0]);
    }
  } catch (e) {
    consecutivePollErrors++;
    err(`Poll exception:`, e.message);
  } finally {
    isProcessing = false;
  }
}

async function cleanup() {
  try {
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const { error } = await supabase
      .from('openclaw_messages')
      .delete()
      .lt('created_at', oneHourAgo)
      .in('status', ['completed', 'error']);
    if (error) err('Cleanup error:', error.message);
  } catch (e) {
    err('Cleanup exception:', e.message);
  }
}

// ===== FUNNEL CRAWL POLLER ========================================
// Runs locally with Playwright so we don't have to fight Netlify's
// lambda timeout for Playwright + SPA-render workloads. Mirrors the
// quizMode branch of src/lib/crawl-runner.ts (agentic: open page,
// fill required fields, click most-likely-CTA, capture URL+title,
// repeat until checkout / no progress). Kept intentionally simpler:
// no screenshots, no network capture — the checkpoint flow only
// needs the list of URLs to seed funnel_pages.

// Patterns that mark a "primary action" element. We use this on three
// kinds of pages:
//   - quiz step  → Next/Continue/Avanti
//   - landing    → Get Instant Access / Unleash / Start Your Journey
//   - checkout   → Buy Now / Add to Cart / Complete Order / Pay Now
// Keeping all of them in one regex lets the same heuristic carry the
// crawler from quiz step #1 all the way to the order summary without
// branching by page type.
const QUIZ_NEXT_PATTERN_SOURCE =
  'next|continue|avanti|continua|→|submit|' +
  // generic results / claim
  'get\\s*(my|your)?\\s*result|see\\s*result|claim(\\s*(my|your))?\\s*(spot|access|discount|offer|reward)?|' +
  // start / proceed / skip-forward verbs
  'start(\\s*(now|here|your\\s*journey))?|begin|inizia|scopri|prossimo|vai\\s*avanti|ottieni|next\\s*step|go|vai|proceed|' +
  // landing-page CTAs
  'instant\\s*access|your\\s*journey|get\\s*(everything|instant|now|started|access|it\\s*now)|' +
  'unleash|unlock(\\s*(my|your))?\\s*(access|offer|spot)?|reveal\\s*(my|your)?\\s*(result|plan)?|' +
  // commerce CTAs
  'buy(\\s*(it\\s*)?now)?|add\\s*to\\s*(cart|bag)|order\\s*now|complete(\\s*(my|your))?\\s*order|' +
  'checkout|check\\s*out|purchase|pay(\\s*now)?|place\\s*order|' +
  // "Yes, I want / Claim mine / Join now"
  'yes.{0,18}(want|claim|get|please|need|i\\s*do)|join(\\s*now)?|sign\\s*me\\s*up|' +
  // i18n
  'siguiente|seguir|weiter|suivant|continuer|próximo|continuar|comprar|comprare|acquista|paga\\s*ora';

// Speed-tuned for quiz funnels. We used to wait 120s for nav and 2.5s
// after each click — total overhead ~5-30s per step on tracker-heavy
// pages (networkidle never settles when GA/FB Pixel/Hotjar are present).
// Now: 25s nav cap, 800ms post-click wait, and we BLOCK trackers up
// front (see `route` handler in processCrawlJob) so DOM is ready in
// ~1-2s on most funnels.
const CRAWL_NAV_TIMEOUT_MS = 25_000;
const CRAWL_STEP_WAIT_MS = 800;
const CRAWL_TRANSITION_MS = 600;
const CRAWL_SAME_FINGERPRINT_MAX = 3;
// 40 covers a typical quiz funnel (10–20 questions) + loading screens
// + landing page + checkout + thank-you, with margin. Hard cap further
// down (`Math.min(..., 60)`) prevents runaway loops.
const CRAWL_DEFAULT_MAX_STEPS = 40;
const CRAWL_POLL_INTERVAL_MS = 4000;

// ── checkpoint_audit: local page fetch helpers ────────────────────
// Tunables for the LOCAL page-fetch path used by the new checkpoint
// flow. We do all the heavy lifting in the worker (Playwright on the
// user's PC) so Netlify functions never need to fetch HTML and the
// edge CDN's 30s inactivity timeout becomes irrelevant.
const CHECKPOINT_FETCH_CONCURRENCY = 6;
const CHECKPOINT_FETCH_TIMEOUT_MS = 20_000; // plain fetch
const CHECKPOINT_PLAYWRIGHT_TIMEOUT_MS = 30_000; // Playwright nav
// Heuristic: if the plain-fetched HTML body has fewer than this many
// chars after stripping tags, treat it as a "shell SPA" and fall
// back to Playwright. Real content pages routinely clear this bar.
const CHECKPOINT_SPA_SHELL_TEXT_THRESHOLD = 500;

/**
 * Strip an HTML payload down to compact, audit-ready text. Mirrors
 * `htmlToAuditText` in src/lib/checkpoint-prompts.ts — kept in sync
 * by hand because porting the whole prompts module here would balloon
 * the worker.
 */
function checkpointHtmlToAuditText(html, maxChars = 30000) {
  if (typeof html !== 'string' || html.length === 0) return '';
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(
    /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, inner) => {
      const txt = inner.replace(/<[^>]+>/g, '').trim();
      return txt ? `[CTA-LINK href="${href.slice(0, 200)}"]${txt}[/CTA]` : '';
    },
  );
  out = out.replace(
    /<button\b[^>]*>([\s\S]*?)<\/button>/gi,
    (_m, inner) => {
      const txt = inner.replace(/<[^>]+>/g, '').trim();
      return txt ? `[CTA-BTN]${txt}[/CTA]` : '';
    },
  );
  out = out
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, '\n\n# $2\n')
    .replace(/<\/?(p|li|tr|td|th|div|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  out = out
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + `\n\n[... truncated, original ${out.length} chars]`;
  }
  return out;
}

/**
 * Fetch a single page's HTML for the checkpoint audit. Two-tier
 * strategy:
 *   1) plain `fetch()` with a 20s budget — fast for SSR/SSG pages.
 *   2) if the returned HTML strips down to < SPA_SHELL_TEXT_THRESHOLD
 *      chars (typical React shell with empty <div id="root">), fire
 *      Playwright to get the post-render DOM.
 *
 * Returns `{ ok, html, error, source, durationMs }`. We never throw —
 * the caller drives a per-step error column instead.
 */
async function fetchCheckpointPageHtml(url) {
  const t0 = Date.now();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, html: null, error: 'invalid url', source: null, durationMs: 0 };
  }
  // ── 1. Plain fetch ───────────────────────────────────────────────
  let plainHtml = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHECKPOINT_FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Wasabi Checkpoint Bot — local worker) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('html') || ct === '') {
        plainHtml = await res.text();
      }
    }
  } catch {
    // Plain fetch failed — fall through to Playwright.
  }
  if (plainHtml && plainHtml.length > 0) {
    const stripped = checkpointHtmlToAuditText(plainHtml, 100000);
    if (stripped.length >= CHECKPOINT_SPA_SHELL_TEXT_THRESHOLD) {
      return { ok: true, html: plainHtml, error: null, source: 'fetch', durationMs: Date.now() - t0 };
    }
  }
  // ── 2. Playwright fallback ───────────────────────────────────────
  if (!playwrightChromium) {
    return {
      ok: !!plainHtml,
      html: plainHtml,
      error: plainHtml
        ? null
        : 'plain fetch failed and Playwright is not available in this worker',
      source: plainHtml ? 'fetch-thin' : null,
      durationMs: Date.now() - t0,
    };
  }
  let browser = null;
  try {
    browser = await playwrightChromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--disable-gpu'],
    });
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Wasabi Checkpoint Bot — local worker) AppleWebKit/537.36',
      viewport: { width: 1280, height: 1800 },
    });
    // Block trackers (same list as the crawl path) so navigation
    // doesn't sit on networkidle waiting for analytics beacons.
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (CRAWL_BLOCKED_HOSTS.some((h) => u.includes(h))) return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: CHECKPOINT_PLAYWRIGHT_TIMEOUT_MS,
    });
    // Give SPAs a beat to populate the DOM after DOMContentLoaded.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    const renderedHtml = await page.content();
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
    return {
      ok: true,
      html: renderedHtml,
      error: null,
      source: plainHtml ? 'playwright-spa' : 'playwright-only',
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: !!plainHtml,
      html: plainHtml,
      error: plainHtml
        ? null
        : `playwright failed: ${e && e.message ? e.message : String(e)}`,
      source: plainHtml ? 'fetch-thin' : null,
      durationMs: Date.now() - t0,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Fetch every page of a funnel in parallel (bounded concurrency) and
 * normalise into the `auditSteps` shape the openclaw-build-prompts
 * endpoint expects. Designed to replace the slow, Netlify-side
 * fetchFunnelPagesHtml + htmlToAuditText pipeline that kept tripping
 * the edge inactivity 504.
 */
async function fetchCheckpointFunnelLocally(pages, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const out = new Array(pages.length);
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= pages.length) return;
      const p = pages[i];
      const res = await fetchCheckpointPageHtml(p.url);
      const text = res.ok && res.html ? checkpointHtmlToAuditText(res.html) : '';
      out[i] = {
        index: i + 1,
        url: p.url,
        name: p.name,
        pageType: p.pageType,
        pageText: text,
        fetchError: res.ok && text.length > 0 ? null : res.error || 'empty page',
        source: res.source || null,
        durationMs: res.durationMs,
      };
      done++;
      if (onProgress) {
        try {
          await onProgress(done, pages.length);
        } catch { /* progress callback errors are non-fatal */ }
      }
    }
  }
  const workerCount = Math.min(CHECKPOINT_FETCH_CONCURRENCY, pages.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

// Hosts whose requests we abort to keep navigation fast. These are
// pure analytics/marketing trackers — blocking them never breaks the
// funnel itself (the funnel page renders fine without them) but cuts
// 5-20s of "networkidle never settles" wait per step. Pattern is
// matched against the request URL with .includes().
const CRAWL_BLOCKED_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'facebook.com/tr',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'hotjar.com',
  'static.hotjar.com',
  'clarity.ms',
  'segment.io',
  'segment.com/v1',
  'fullstory.com',
  'mouseflow.com',
  'optimizely.com',
  'mixpanel.com',
  'amplitude.com',
  'snap.licdn.com',
  'px.ads.linkedin.com',
  'pinimg.com',
  'twitter.com/i/adsct',
  'ads.twitter.com',
  'criteo.net',
  'rlcdn.com',
];

let isCrawling = false;

async function updateCrawlJob(jobId, patch) {
  const dbPatch = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) dbPatch.status = patch.status;
  if (patch.result !== undefined) dbPatch.result = patch.result;
  if (patch.error !== undefined) dbPatch.error = patch.error;
  if (patch.currentStep !== undefined) dbPatch.current_step = patch.currentStep;
  if (patch.totalSteps !== undefined) dbPatch.total_steps = patch.totalSteps;
  const { error } = await supabase
    .from('funnel_crawl_jobs')
    .update(dbPatch)
    .eq('id', jobId);
  if (error) {
    err(`updateCrawlJob ${jobId} failed: ${error.message}`);
  }
}

// Capture a viewport-only JPEG of the current page and upload it to
// the public `checkpoint-screenshots` Supabase bucket under
// `crawl/<jobId>/step-<n>.jpg`. Returns the public URL on success or
// null on any failure (we never want a screenshot upload error to
// abort the crawl — losing a thumbnail is acceptable, losing 10 step
// URLs because of one slow upload isn't).
const CRAWL_SCREENSHOT_BUCKET = 'checkpoint-screenshots';
async function captureCrawlScreenshot(page, jobId, stepIndex) {
  let buf;
  try {
    buf = await page.screenshot({
      type: 'jpeg',
      quality: 60,
      // Viewport only — full-page on a 100k-pixel-tall quiz funnel
      // would blow past the 5MB bucket limit and add seconds per step.
      fullPage: false,
      // Tight cap: a screenshot that takes >3s usually means the page
      // is doing layout shifts, not that we'll get a better image by
      // waiting more. Better to drop the thumbnail than to slow the
      // whole crawl by 5-10s/step.
      timeout: 3000,
    });
  } catch (e) {
    err(`  · screenshot capture failed at step ${stepIndex}: ${e.message}`);
    return null;
  }
  if (!buf || buf.length === 0) return null;

  const path = `crawl/${jobId}/step-${String(stepIndex).padStart(3, '0')}.jpg`;
  try {
    const { error } = await supabase.storage
      .from(CRAWL_SCREENSHOT_BUCKET)
      .upload(path, buf, {
        contentType: 'image/jpeg',
        cacheControl: '3600',
        upsert: true,
      });
    if (error) {
      err(`  · screenshot upload failed at step ${stepIndex}: ${error.message}`);
      return null;
    }
  } catch (e) {
    err(`  · screenshot upload threw at step ${stepIndex}: ${e.message}`);
    return null;
  }

  const { data: pub } = supabase.storage
    .from(CRAWL_SCREENSHOT_BUCKET)
    .getPublicUrl(path);
  return pub?.publicUrl || null;
}

// Returns a short human-readable label for the current step. We try to
// pull the most prominent heading/question text on the page so the
// modal can show "Step 3: Quanti anni hai?" instead of 11 identical
// rows for an SPA quiz where the URL never changes.
async function getStepLabel(page) {
  return page
    .evaluate(() => {
      const candidates = [
        'h1',
        '.quiz-question',
        '[class*="question"]',
        '[data-question]',
        '[class*="step-title"]',
        '[class*="step-heading"]',
        'h2',
        '[class*="title"]',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const txt = (el.innerText || '').trim();
        if (!txt) continue;
        if (txt.length < 3) continue;
        return txt.replace(/\s+/g, ' ').slice(0, 140);
      }
      const main =
        document.querySelector('main, [role="main"], .quiz-container, #quiz') ||
        document.body;
      const fallback = (main.innerText || '').trim().split('\n').find((l) => l.trim().length > 4);
      return fallback ? fallback.replace(/\s+/g, ' ').slice(0, 140) : '';
    })
    .catch(() => '');
}

async function getQuizFingerprint(page) {
  return page.evaluate(() => {
    const main =
      document.querySelector(
        'main, [role="main"], .quiz-container, .quiz-content, [class*="quiz"], #quiz, .content, [class*="content"]',
      ) || document.body;
    const text = (main.innerText || '').slice(0, 5000);
    const h1 = (document.querySelector('h1') || {}).innerText || '';
    const h2 = (document.querySelector('h2') || {}).innerText || '';
    const stepEl = document.querySelector(
      '[data-step], [data-question], .step, .slide, [class*="step"]',
    );
    const stepAttr = stepEl
      ? stepEl.getAttribute('data-step') ||
        stepEl.getAttribute('data-question') ||
        stepEl.className
      : '';
    return `${h1}|${h2}|${stepAttr}|${text.length}|${text.slice(0, 800)}`;
  });
}

async function fillCrawlFormFields(page) {
  return page.evaluate(() => {
    let filled = 0;
    const inputs = Array.from(
      document.querySelectorAll(
        'input:not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]):not([type="hidden"]):not([type="file"]), textarea, select',
      ),
    );
    for (const el of inputs) {
      if (el.value && String(el.value).trim().length > 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;

      const type = (el.type || '').toLowerCase();
      const hint = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
      let value = '';

      if (el.tagName === 'SELECT') {
        const firstReal = Array.from(el.options).find(
          (o) =>
            o.value && o.value !== '0' && !/seleziona|select|choose|---/i.test(o.text),
        );
        if (firstReal) {
          el.value = firstReal.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        }
        continue;
      }

      if (type === 'email' || /email|e-mail|mail/.test(hint)) value = 'test@example.com';
      else if (type === 'tel' || /phone|tel|cell|mobile|telefono/.test(hint)) value = '3331234567';
      else if (type === 'number' || /age|year|amount|peso|weight|altezza|height|importo/.test(hint)) value = '30';
      else if (/zip|postal|cap/.test(hint)) value = '00100';
      else if (/first.*name|nome|prenom|given.*name/.test(hint)) value = 'Mario';
      else if (/last.*name|surname|cognome|family.*name/.test(hint)) value = 'Rossi';
      else if (/full.*name|name/.test(hint)) value = 'Mario Rossi';
      else if (type === 'date') value = '1990-01-01';
      else if (type === 'url') value = 'https://example.com';
      else if (type === 'text' || type === 'search' || type === '' || el.tagName === 'TEXTAREA') value = 'Test';
      else continue;

      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filled++;
    }

    const cb = Array.from(
      document.querySelectorAll('input[type="checkbox"]:not(:checked)'),
    ).find((c) => {
      const r = c.getBoundingClientRect();
      const s = window.getComputedStyle(c);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    });
    if (cb) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      cb.dispatchEvent(new Event('click', { bubbles: true }));
    }

    // Tick one radio per radio group. On a quiz funnel each step is
    // typically one radio group; without ticking one the "Next" CTA
    // is disabled. We pick the first visible option so the answer
    // doesn't bias the crawl — for the checkpoint use case we only
    // care about WHICH steps exist, not what was answered.
    const radios = Array.from(
      document.querySelectorAll('input[type="radio"]'),
    ).filter((r) => {
      const rect = r.getBoundingClientRect();
      const s = window.getComputedStyle(r);
      // Use offsetParent === null to catch hidden parents too. Many
      // quiz funnels render the actual <input> as visually-hidden and
      // overlay a custom label; we still want to register a click on
      // the input (or its label) so the form state updates.
      return s.display !== 'none' && s.visibility !== 'hidden' && rect.width >= 0;
    });
    const groupsTicked = new Set();
    for (const r of radios) {
      const groupKey = r.name || r.getAttribute('data-group') || `__solo_${groupsTicked.size}`;
      if (groupsTicked.has(groupKey)) continue;
      // Skip if any sibling in the same group is already checked.
      if (r.name) {
        const already = document.querySelector(`input[type="radio"][name="${CSS.escape(r.name)}"]:checked`);
        if (already) {
          groupsTicked.add(groupKey);
          continue;
        }
      } else if (r.checked) {
        groupsTicked.add(groupKey);
        continue;
      }
      try {
        // Prefer clicking the <label> if one exists — quiz funnels
        // often style the label as the visible button and listen for
        // label clicks rather than input changes.
        const lbl = r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null;
        if (lbl) {
          lbl.click();
        } else {
          r.click();
        }
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        groupsTicked.add(groupKey);
        filled++;
      } catch {
        /* try next radio */
      }
    }

    return filled;
  });
}

// (legacy: per-step LLM advance was removed because it added 30-60s
// of latency per step on the local Trinity backend and timed out the
// crawler. Navigation now relies entirely on fillCrawlFormFields +
// clickCrawlAdvance, which together handle ~all real-world quiz funnels.)
async function _legacyLlmChooseAdvance_unused(page, attemptNumber) {
  // 1. Gather the same set of "interactive" elements the heuristic
  //    would have considered. Index in this array is what we hand to
  //    the LLM and what we use to re-locate the element for clicking.
  const SELECTOR =
    'button, [role="button"], input[type="submit"], a[class*="btn"], a[class*="button"], label[for], input[type="radio"]:not(:checked), [class*="option"]:not([aria-selected="true"]), [class*="answer"], [class*="choice"], [class*="cta"], [class*="next"], a[href]';

  const elements = await page
    .evaluate((sel) => {
      const out = [];
      const all = Array.from(document.querySelectorAll(sel));
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) continue;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        const text = (el.innerText || '').trim() || el.value || el.placeholder || '';
        if (!text) continue;
        if (text.length > 200) continue;
        out.push({
          text: text.slice(0, 120),
          tag: el.tagName.toLowerCase(),
          type: (el.type || '').toLowerCase(),
          aria: (el.getAttribute('aria-label') || '').slice(0, 80),
        });
        if (out.length >= 35) break;
      }
      return out;
    }, SELECTOR)
    .catch(() => []);

  if (!elements || elements.length === 0) return null;

  const url = page.url();
  const title = await page.title().catch(() => '');
  const visibleText = await page
    .evaluate(() => (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 1800))
    .catch(() => '');

  const list = elements
    .map((e, i) => {
      const meta = [e.tag + (e.type ? '/' + e.type : ''), e.aria].filter(Boolean).join(' · ');
      return `[${i}] "${e.text}"  (${meta})`;
    })
    .join('\n');

  const systemPrompt = `Sei un agente che naviga un funnel di vendita per scoprire ogni step (landing → quiz → offerta → checkout).
Ad ogni turno ricevi:
- l'URL e il titolo della pagina attuale
- il testo visibile (parziale)
- una lista numerata di elementi cliccabili visibili a schermo

Devi scegliere l'elemento che porta al passo SUCCESSIVO del funnel: tipicamente un CTA primario tipo "Continua", "Avanti", "Inizia", "Scopri", "Ottieni", una risposta a una domanda di quiz, un radio button con risposta plausibile, o un pulsante di submit.
NON cliccare: link a privacy/cookie/termini/footer, "indietro", "skip", logo, navigazione di sito.
Se l'URL o il titolo dicono che siamo al checkout / pagamento / pagina di errore / pagina di conferma → "done".
Se ti sembra una landing finale senza altro da cliccare → "done".

RISPONDI ESCLUSIVAMENTE con un singolo oggetto JSON, senza testo prima o dopo, senza markdown:
{"action":"click","index":<intero>,"reasoning":"<frase breve>"}
oppure
{"action":"done","reasoning":"<frase breve>"}`;

  const userPrompt = `URL: ${url}
Titolo: ${title}
Step #${attemptNumber + 1}

--- Testo visibile ---
${visibleText}

--- Elementi cliccabili ---
${list}

Quale index clicco per andare avanti nel funnel?`;

  let reply;
  try {
    _callContext = {
      source: 'funnel_crawl_navigation',
      metadata: { step: attemptNumber + 1 },
    };
    reply = await callOpenClaw([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);
  } catch (e) {
    err(`  · LLM-advance failed: ${e.message} — falling back to heuristic`);
    return null;
  } finally {
    _callContext = null;
  }

  const cleaned = String(reply || '')
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '');
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a < 0 || b <= a) {
    err(`  · LLM-advance: no JSON in reply ("${cleaned.slice(0, 80)}…") — falling back`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned.substring(a, b + 1));
  } catch {
    err(`  · LLM-advance: invalid JSON — falling back`);
    return null;
  }

  if (parsed.action === 'done') {
    log(`  · LLM: done (${parsed.reasoning || 'no reasoning'})`);
    return { done: true };
  }
  if (parsed.action !== 'click') return null;
  const idx = Number(parsed.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= elements.length) {
    err(`  · LLM-advance: out-of-range index ${parsed.index} (have ${elements.length} elements) — falling back`);
    return null;
  }

  const target = elements[idx];
  log(`  · LLM picked [${idx}] "${target.text}" — ${parsed.reasoning || ''}`);

  // Re-locate the same element by replaying the same enumeration order
  // and clicking the Nth match. Doing it this way (instead of caching
  // an ElementHandle) avoids stale-handle errors on SPAs that re-render
  // between the page.evaluate call above and now.
  const clicked = await page
    .evaluate(
      ({ idx, sel }) => {
        const all = Array.from(document.querySelectorAll(sel));
        let counter = -1;
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) continue;
          const style = window.getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          const text = (el.innerText || '').trim() || el.value || el.placeholder || '';
          if (!text) continue;
          if (text.length > 200) continue;
          counter++;
          if (counter === idx) {
            try {
              el.scrollIntoView({ block: 'center' });
              el.click();
              return true;
            } catch {
              return false;
            }
          }
        }
        return false;
      },
      { idx, sel: SELECTOR },
    )
    .catch(() => false);

  if (!clicked) {
    err(`  · LLM-advance: click on index ${idx} failed in DOM — falling back`);
    return null;
  }
  return { done: false, clicked: true };
}

async function clickCrawlAdvance(page, patternSource) {
  return page.evaluate((src) => {
    const pattern = new RegExp(src, 'i');
    const NEG_PATTERN = /^(skip|salta|indietro|back|prev|previous|cancel|annulla|chiudi|close|home|privacy|cookie|termini|terms|login|accedi|menu|languag)/i;

    // Two passes:
    //   1. Standard CTA (button/anchor with btn/cta classes etc.) —
    //      handles "Continue / Avanti / Submit" pages.
    //   2. Quiz answer fallback (any clickable element with substantial
    //      text content) — handles SPA quizzes where the answer ITSELF
    //      is the advance trigger and there's no explicit Next button.
    //      Without this fallback the crawler stops at the first answer
    //      page (e.g. "Which season of life are you in right now?").
    //
    // We do (1) first; if it returns 0 candidates, fall back to (2).

    // Includes plain `a[href]` so we can catch landing/checkout CTAs
    // styled with utility classes (Tailwind `rounded-full px-10 py-4`
    // etc.) that don't have any of the historical btn/cta/button class
    // tokens. The priority scoring below filters out nav links — only
    // anchors whose text matches the CTA pattern can win pass 1.
    const PRIMARY_SEL =
      'button, [role="button"], input[type="submit"], input[type="button"], ' +
      'a[href], [class*="cta"], [class*="next-button"]';
    // Broader: anything that looks tappable. React quiz funnels often
    // render answer cards as <div onClick> with no semantic role, so we
    // also pick up <div>/<li>/<label> with role="button" or known answer
    // class names.
    const ANSWER_SEL =
      'button, [role="button"], [role="option"], [class*="option"], [class*="answer"], [class*="choice"], [class*="card"][onclick], li[onclick], div[onclick], label[for]';

    const viewportH = window.innerHeight || 800;
    const viewportW = window.innerWidth || 1280;

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 24) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      // Cull elements that are far off-screen (tab content not in view).
      if (rect.bottom < 0 || rect.top > viewportH * 3) return false;
      if (rect.right < 0 || rect.left > viewportW) return false;
      return true;
    }
    function getText(el) {
      return ((el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '') + '').trim();
    }

    // ─── PASS 1: explicit CTA buttons ────────────────────────────
    const primaryCandidates = [];
    document.querySelectorAll(PRIMARY_SEL).forEach((el) => {
      const text = getText(el);
      if (!text || text.length > 80) return;
      if (NEG_PATTERN.test(text)) return;
      if (!isVisible(el)) return;

      const rect = el.getBoundingClientRect();
      const cls = el.className || '';
      let priority = 0;
      if (pattern.test(text)) priority += 100;
      if (el.type === 'submit') priority += 30;
      if (el.tagName === 'BUTTON') priority += 10;
      if (/btn|button|cta|next|submit|continue|primary/i.test(cls)) priority += 8;
      // Tailwind/utility "shaped like a button": rounded + px-/py- padding
      // is a strong tell of a CTA on landing pages where authors don't
      // use semantic class names. Boost so styled <a> CTAs beat
      // `<button class="hamburger">` or footer links.
      if (typeof cls === 'string' && /\brounded(-full|-lg|-xl|-2xl)?\b/.test(cls) &&
          /(\bpx-\d|\bpy-\d|\bp-\d)/.test(cls)) {
        priority += 12;
      }
      // Generic "$NN" / "$NN.NN" / "€NN" in button text → it's almost
      // certainly a price/buy CTA, give it a strong nudge.
      if (/[$€£]\s?\d/.test(text)) priority += 10;
      if (rect.top > viewportH * 0.4) priority += 5;
      if (rect.top >= 0 && rect.bottom <= viewportH) priority += 2;
      // Penalise pure anchor links that are clearly nav/footer (text
      // matches NEG_PATTERN was already filtered, but bare anchors
      // without any styling and with very short text — "Home", "FAQ" —
      // shouldn't beat real CTAs).
      if (el.tagName === 'A' && text.length < 5 && !/[$€£]/.test(text)) priority -= 5;
      primaryCandidates.push({ el, priority, text });
    });

    primaryCandidates.sort((a, b) => b.priority - a.priority);
    // Only accept the primary winner if it actually matches the CTA
    // pattern — a generic <button> with random text isn't a CTA, it
    // might be a hamburger/menu icon. If pattern doesn't match, fall
    // through to the answer-card pass.
    if (
      primaryCandidates.length > 0 &&
      (pattern.test(primaryCandidates[0].text) ||
        primaryCandidates[0].el.type === 'submit')
    ) {
      const winner = primaryCandidates[0];
      try {
        winner.el.scrollIntoView({ block: 'center', behavior: 'instant' });
      } catch {
        /* ignore */
      }
      try {
        winner.el.click();
        // eslint-disable-next-line no-console
        console.log(`[crawl] CTA clicked: "${winner.text.slice(0, 60)}"`);
        return true;
      } catch {
        /* fall through */
      }
    }

    // ─── PASS 2: quiz answer cards ───────────────────────────────
    // No CTA matched. Look for groups of clickable elements that look
    // like answer choices (multiple visible items, similar size, none
    // is a Next button). Click the FIRST one — the actual answer
    // choice doesn't matter for crawling, we just need to advance.
    const answerCandidates = [];
    const seen = new Set();
    document.querySelectorAll(ANSWER_SEL).forEach((el) => {
      // Dedup nested matches (a <button> inside a [role=button] container).
      // We use the element with the smallest descendant count that still
      // contains the text — basically: prefer leaves.
      if (seen.has(el)) return;
      const text = getText(el);
      if (!text || text.length < 2 || text.length > 160) return;
      if (NEG_PATTERN.test(text)) return;
      if (pattern.test(text)) return; // those went through pass 1
      if (!isVisible(el)) return;

      // Skip elements that fully contain another candidate (we'd
      // double-click). Mark all descendants as seen.
      el.querySelectorAll(ANSWER_SEL).forEach((d) => seen.add(d));

      const rect = el.getBoundingClientRect();
      let priority = 0;
      // Prefer answer-class elements (these are explicitly quiz answers).
      if (/answer|choice|option|quiz/i.test(el.className || '')) priority += 8;
      if (el.tagName === 'BUTTON') priority += 4;
      // Prefer elements that look like distinct cards (full-width-ish).
      if (rect.width > viewportW * 0.4) priority += 3;
      // Prefer earlier in document order so we click the first answer
      // (typical UX expectation: top-to-bottom reading order).
      // We bake this into the order naturally because we push in order.
      answerCandidates.push({ el, priority, text, top: rect.top });
    });

    if (answerCandidates.length >= 2) {
      // Sort: highest priority first, then top-to-bottom.
      answerCandidates.sort((a, b) => b.priority - a.priority || a.top - b.top);
      const winner = answerCandidates[0];
      try {
        winner.el.scrollIntoView({ block: 'center', behavior: 'instant' });
      } catch {
        /* ignore */
      }
      try {
        winner.el.click();
        // eslint-disable-next-line no-console
        console.log(`[crawl] answer clicked: "${winner.text.slice(0, 60)}"`);
        return true;
      } catch {
        /* try second-best */
        if (answerCandidates[1]) {
          try {
            answerCandidates[1].el.click();
            return true;
          } catch {
            /* give up */
          }
        }
      }
    }

    // ─── PASS 3: last resort, any remaining primary candidate ────
    // If pass 1 had a non-pattern winner (e.g. a generic <button>),
    // click it now as a final attempt to advance.
    for (const { el, text } of primaryCandidates) {
      try {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
      } catch {
        /* ignore */
      }
      try {
        el.click();
        // eslint-disable-next-line no-console
        console.log(`[crawl] generic clicked: "${text.slice(0, 60)}"`);
        return true;
      } catch {
        /* try next */
      }
    }
    return false;
  }, patternSource);
}

function isCheckoutLikePage(url, title) {
  const u = (`${url} ${title || ''}`).toLowerCase();
  return /checkout|carrello|cart|pagamento|payment|acquista|buy\s*now|ordine|order\s*summary|pay\s*now/i.test(u);
}

async function processCrawlJob(row) {
  const startedAt = Date.now();
  const jobId = row.id;
  const params = row.params || {};
  const entryUrl = params.entryUrl || row.entry_url;
  const maxSteps = Math.min(
    Math.max(1, Number(params.quizMaxSteps || params.maxSteps || CRAWL_DEFAULT_MAX_STEPS)),
    60,
  );

  log(`crawl #${jobId}: starting (entry=${entryUrl}, maxSteps=${maxSteps})`);
  await updateCrawlJob(jobId, { status: 'running', currentStep: 0, totalSteps: maxSteps });

  let browser = null;
  const steps = [];
  try {
    browser = await playwrightChromium.launch({
      headless: params.headless !== false,
      args: ['--disable-dev-shm-usage', '--disable-gpu'],
    });
    const context = await browser.newContext({
      viewport: {
        width: params.viewportWidth || 1280,
        height: params.viewportHeight || 720,
      },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(CRAWL_NAV_TIMEOUT_MS);

    // Block trackers so the page reaches an interactive state in 1-2s
    // instead of waiting 10-30s for GA/FB Pixel/Hotjar requests that
    // never settle. Quiz funnels never need these to function.
    await page.route('**/*', (route) => {
      try {
        const reqUrl = route.request().url();
        const rtype = route.request().resourceType();
        // Drop heavy media we don't need — saves bandwidth + render
        // time. We still allow stylesheet + font so the screenshot
        // looks right.
        if (rtype === 'media' || rtype === 'websocket') {
          return route.abort();
        }
        for (const host of CRAWL_BLOCKED_HOSTS) {
          if (reqUrl.includes(host)) return route.abort();
        }
        return route.continue();
      } catch {
        return route.continue();
      }
    });

    let normalizedEntry = entryUrl;
    try {
      const u = new URL(entryUrl);
      normalizedEntry = u.origin + u.pathname + u.search;
    } catch {
      /* keep raw */
    }

    const goResp = await page.goto(normalizedEntry, {
      waitUntil: 'domcontentloaded',
      timeout: CRAWL_NAV_TIMEOUT_MS,
    });
    if (!goResp) throw new Error('Initial navigation returned no response');
    // Wait for "load" (cheaper than networkidle) with a short cap. We
    // don't NEED the page to be quiet — we need it to be interactive,
    // and 'load' covers that on 99% of funnels. Cap at 4s so a slow
    // tracker that we forgot to block doesn't blow the budget.
    await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});

    let consecutiveSame = 0;
    // Populated whenever the loop breaks BEFORE reaching maxSteps.
    // Persisted into `result.stopDiagnostic` at the end so the user
    // (and we) can post-mortem the crawl without needing access to
    // the worker's stdout — answers "why did it stop at step N?"
    let stopDiagnostic = null;
    const captureDomInventory = (page) =>
      page
        .evaluate(() => {
          const out = [];
          const sel =
            'button, [role="button"], input[type="submit"], input[type="button"], a, [class*="btn"], [class*="cta"], [class*="answer"], [class*="option"], [class*="choice"], [onclick]';
          document.querySelectorAll(sel).forEach((el) => {
            if (out.length >= 40) return;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            const visible =
              r.width >= 5 &&
              r.height >= 5 &&
              s.visibility !== 'hidden' &&
              s.display !== 'none' &&
              s.opacity !== '0';
            if (!visible) return;
            const text = ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').trim().slice(0, 80);
            if (!text && el.tagName !== 'BUTTON') return;
            out.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className || '').toString().slice(0, 80),
              w: Math.round(r.width),
              h: Math.round(r.height),
              text: text || '(empty)',
              disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
              href: el.getAttribute('href') || null,
            });
          });
          return out;
        })
        .catch(() => []);

    while (steps.length < maxSteps) {
      const fp = await getQuizFingerprint(page).catch(() => '');
      const title = await page.title().catch(() => '');
      const url = page.url();
      const label = await getStepLabel(page);

      const nextIndex = steps.length + 1;
      // Capture the screenshot BEFORE pushing the step so we can attach
      // the URL inline. We do it before the click that advances the
      // funnel, so the thumbnail shows what the user saw at that step.
      const screenshotUrl = await captureCrawlScreenshot(page, jobId, nextIndex);

      steps.push({
        stepIndex: nextIndex,
        url,
        title,
        // `quizStepLabel` is what the checkpoint modal renders as the
        // row title — for SPA funnels (URL never changes) it's the only
        // way for the user to tell steps apart. Falls back to title +
        // index so the row is never blank.
        quizStepLabel: label || title || `Step ${nextIndex}`,
        // Public Supabase Storage URL. Null if upload failed; the UI
        // gracefully falls back to URL-only when missing.
        screenshotUrl,
        timestamp: new Date().toISOString(),
        isQuizStep: true,
      });
      log(
        `  · step ${steps.length}/${maxSteps}: ${url}` +
          (label ? `  ⟶ ${label.slice(0, 80)}` : '') +
          (screenshotUrl ? '  📸' : ''),
      );
      await updateCrawlJob(jobId, {
        currentStep: steps.length,
        totalSteps: maxSteps,
      });

      if (isCheckoutLikePage(url, title)) {
        log(`  · checkout-like page detected, stopping`);
        stopDiagnostic = {
          reason: 'checkout_like_page',
          atStep: steps.length,
          url,
          title,
          label,
          maxSteps,
        };
        break;
      }

      // Wait for the page to actually have a visible interactive
      // element before we try to click. React quiz funnels often
      // animate-in their CTA / answer cards 200-1000ms after the
      // previous transition completes, so calling clickAdvance too
      // early sees an empty DOM.
      await page
        .waitForFunction(
          () => {
            const els = document.querySelectorAll(
              'button, [role="button"], input[type="submit"], a[class*="btn"], [class*="cta"], [class*="answer"], [class*="option"]',
            );
            for (const el of els) {
              const rect = el.getBoundingClientRect();
              if (rect.width >= 40 && rect.height >= 24) {
                const s = window.getComputedStyle(el);
                if (s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0') {
                  return true;
                }
              }
            }
            return false;
          },
          { timeout: 3500 },
        )
        .catch(() => {
          /* timeout — the page genuinely has no buttons; clickAdvance
             will return false and the loop will break with the right
             diagnostic. */
        });

      await fillCrawlFormFields(page).catch(() => 0);

      // Pure Playwright + heuristic. Previous version asked the LLM
      // per click, but that was both very slow (Trinity ~30-60s per
      // decision) and unnecessary — the regex priority queue already
      // handles ~95% of quiz funnels.
      let advanced = await clickCrawlAdvance(page, QUIZ_NEXT_PATTERN_SOURCE).catch(
        () => false,
      );
      // Retry once after a short wait. On animated SPA quizzes the CTA
      // sometimes appears 500-1500ms after the previous transition; a
      // single retry catches those without making the happy path slow.
      if (!advanced) {
        await new Promise((r) => setTimeout(r, 1200));
        advanced = await clickCrawlAdvance(page, QUIZ_NEXT_PATTERN_SOURCE).catch(
          () => false,
        );
      }
      if (!advanced) {
        // Verbose dump so we can see WHAT was on the page when we
        // gave up — text + selector of every visible button-like
        // element. Logged once per crawl, only on stop, so it doesn't
        // bloat the worker log on happy paths.
        const inventory = await captureDomInventory(page);
        log(`  · no clickable advance found, stopping. DOM inventory at this step:`);
        for (const it of inventory.slice(0, 20)) {
          log(`      [${it.tag}] "${it.text}" — ${it.w}x${it.h} ${it.disabled ? '(disabled)' : ''} class="${it.cls}"`);
        }
        if (inventory.length > 20) {
          log(`      ... +${inventory.length - 20} more elements not shown`);
        }
        stopDiagnostic = {
          reason: 'no_advance_button',
          atStep: steps.length,
          url,
          title,
          label,
          maxSteps,
          inventory,
          hint:
            "The clicker's regex (QUIZ_NEXT_PATTERN_SOURCE) didn't match any visible CTA. Look at `inventory` for the button text on this page and add a matching alternative to the regex (or fix the page's button labels).",
        };
        break;
      }

      // Active wait: poll the fingerprint at 100ms intervals and break
      // as soon as it changes. Caps at CRAWL_STEP_WAIT_MS so a stuck
      // page doesn't block the loop forever. On fast SPAs this returns
      // in ~200-400ms instead of always sleeping 800ms.
      const transitionDeadline = Date.now() + CRAWL_STEP_WAIT_MS;
      let newFp = fp;
      while (Date.now() < transitionDeadline) {
        await new Promise((r) => setTimeout(r, 100));
        newFp = await getQuizFingerprint(page).catch(() => fp);
        if (newFp !== fp) break;
      }
      if (newFp === fp) {
        // Sometimes the click triggers a slow transition (lazy-loaded
        // next slide). Give it one extra grace period before counting
        // it as a stuck page.
        await new Promise((r) => setTimeout(r, CRAWL_TRANSITION_MS));
        newFp = await getQuizFingerprint(page).catch(() => fp);
      }
      if (newFp === fp) {
        consecutiveSame++;
        if (consecutiveSame >= CRAWL_SAME_FINGERPRINT_MAX) {
          log(`  · stuck on same fingerprint ${consecutiveSame}× — stopping`);
          stopDiagnostic = {
            reason: 'stuck_fingerprint',
            atStep: steps.length,
            url,
            title,
            label,
            maxSteps,
            consecutiveSame,
            inventory: await captureDomInventory(page),
            hint:
              "We DID click an advance button, but the page's text fingerprint never changed. Either the click didn't actually trigger a transition (wrong button), or the next slide is a duplicate that the dedupe heuristic interpreted as 'no progress'.",
          };
          break;
        }
      } else {
        consecutiveSame = 0;
      }
    }
    // If the loop exited because we hit maxSteps cleanly (no early
    // break), record that too so the dashboard can distinguish "user
    // capped at 25 and we DELIVERED 25" from "we genuinely walked
    // the whole funnel, here are all 8 pages it has".
    if (!stopDiagnostic && steps.length >= maxSteps) {
      stopDiagnostic = {
        reason: 'reached_max_steps',
        atStep: steps.length,
        maxSteps,
        hint:
          "Crawl hit the configured maxSteps limit. The funnel might continue further — bump quizMaxSteps to discover more.",
      };
    }

    await page.close().catch(() => {});

    const result = {
      success: true,
      entryUrl,
      steps,
      totalSteps: steps.length,
      durationMs: Date.now() - startedAt,
      visitedUrls: steps.map((s) => s.url),
      isQuizFunnel: true,
      stopDiagnostic,
    };
    await updateCrawlJob(jobId, {
      status: 'completed',
      result,
      currentStep: steps.length,
      totalSteps: steps.length,
    });
    log(`✅ crawl #${jobId}: completed ${steps.length} step in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (e) {
    err(`crawl #${jobId} failed:`, e.message);
    await updateCrawlJob(jobId, {
      status: 'failed',
      error: e.message,
      result: {
        success: false,
        entryUrl,
        steps,
        totalSteps: steps.length,
        durationMs: Date.now() - startedAt,
        visitedUrls: steps.map((s) => s.url),
        isQuizFunnel: true,
      },
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function pollCrawlJobs() {
  if (isCrawling) return;
  if (!playwrightChromium) return;
  isCrawling = true;
  try {
    // Same target_agent semantics as openclaw_messages: a row tagged
    // for a specific agent (target_agent='openclaw:neo' / 'openclaw:morfeo')
    // can only be claimed by that worker. Untagged rows
    // (target_agent IS NULL) stay first-come-first-served so legacy
    // jobs created before the column existed keep working.
    let query = supabase
      .from('funnel_crawl_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);
    if (OPENCLAW_AGENT) {
      query = query.or(`target_agent.is.null,target_agent.eq.${OPENCLAW_AGENT}`);
    }
    const { data, error } = await query;
    if (error) {
      err(`crawl poll error: ${error.message}`);
      return;
    }
    if (!data || data.length === 0) return;
    const row = data[0];

    // Atomic claim: only proceed if our update flips status from pending → running.
    const { data: claimed, error: claimErr } = await supabase
      .from('funnel_crawl_jobs')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (claimErr || !claimed) {
      // Lost the race to another worker / already taken — try next tick.
      return;
    }

    await processCrawlJob(row);
  } catch (e) {
    err(`crawl poll exception: ${e.message}`);
  } finally {
    isCrawling = false;
  }
}

// ===== STARTUP ====================================================
function printBanner() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║           OpenClaw Worker v2               ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  Supabase URL:  ${SUPABASE_URL.substring(0, 28).padEnd(28)}║`);
  console.log(`║  Backend:       ${OPENCLAW_BACKEND.padEnd(28)}║`);
  if (OPENCLAW_BACKEND === 'anthropic') {
    const keyHint = ANTHROPIC_API_KEY
      ? `${ANTHROPIC_API_KEY.slice(0, 8)}…(${ANTHROPIC_API_KEY.length} chars)`
      : '(MISSING — worker will fail on first job!)';
    console.log(`║  Endpoint:      api.anthropic.com:443      ║`);
    console.log(`║  API key:       ${keyHint.padEnd(28).substring(0, 28)}║`);
  } else {
    console.log(`║  Endpoint:      ${(OPENCLAW_HOST + ':' + OPENCLAW_PORT).padEnd(28)}║`);
  }
  console.log(`║  Model:         ${OPENCLAW_MODEL.padEnd(28).substring(0, 28)}║`);
  console.log(`║  Max tokens:    ${String(OPENCLAW_MAX_TOKENS).padEnd(28)}║`);
  console.log(
    `║  Agent:         ${(OPENCLAW_AGENT || '(unset → legacy any-job mode)').padEnd(28).substring(0, 28)}║`,
  );
  console.log(`║  Poll:          every ${POLL_INTERVAL_MS / 1000}s`.padEnd(45) + '║');
  console.log(
    `║  Crawl poller:  ${(playwrightChromium ? `enabled (every ${CRAWL_POLL_INTERVAL_MS / 1000}s)` : 'disabled (no playwright-core)').padEnd(28).substring(0, 28)}║`,
  );
  console.log('╚════════════════════════════════════════════╝');
  if (OPENCLAW_BACKEND === 'anthropic' && !ANTHROPIC_API_KEY) {
    err(
      'OPENCLAW_BACKEND=anthropic but ANTHROPIC_API_KEY is empty — every checkpoint_audit and chat job will fail until you export ANTHROPIC_API_KEY=sk-ant-... and restart.',
    );
  }
  if (OPENCLAW_AGENT) {
    log(`Routing: this worker only claims jobs targeted at "${OPENCLAW_AGENT}" (or untagged legacy jobs).`);
  } else {
    log('Routing: legacy mode — claims ANY pending job (set OPENCLAW_AGENT or rename the OS user to enable explicit routing).');
  }
  if (STATIC_EXTRA_CONTEXT) {
    log(`Static extra context loaded from ${STATIC_EXTRA_CONTEXT.path} (${STATIC_EXTRA_CONTEXT.content.length} chars) — sara' iniettato in OGNI swipe rewrite.`);
  } else {
    log('No static extra context — set OPENCLAW_EXTRA_CONTEXT_FILE=/path/to/notes.md or drop "openclaw-extra-context.md" accanto al worker per dargli knowledge personale (brand book, claims approvati, ecc.).');
  }
  log(
    `Rewrite quality mode: ${REWRITE_QUALITY_MODE} (batch size ${REWRITE_BATCH_SIZE}, max_tokens ${OPENCLAW_MAX_TOKENS}).`
    + (REWRITE_QUALITY_MODE === 'oneshot'
      ? ' Modalita\' ONESHOT: 1 call con tutti i testi insieme (come Telegram). Veloce + qualita\' max. Se il tuo modello locale ha context stretto: REWRITE_QUALITY_MODE=fast'
      : REWRITE_QUALITY_MODE === 'chat'
        ? ' Modalita\' agent-loop nativa (call conversazionale per ogni testo). Lento.'
        : ` Modalita' batch JSON. L'ultimo gap-fill pass usa comunque CHAT-STYLE per recuperare i mancanti. Per max velocita': REWRITE_QUALITY_MODE=oneshot`),
  );
  if (!playwrightChromium) {
    log(
      'Funnel crawl poller DISABLED: playwright-core not found. Run `npm install` then `npx playwright install chromium` if you want this worker to also process auto-discover funnel jobs.',
    );
  } else {
    log(
      `Funnel crawl poller enabled — claiming pending rows from funnel_crawl_jobs every ${CRAWL_POLL_INTERVAL_MS / 1000}s.`,
    );
  }
  log('Worker started. Waiting for messages...');
}

process.on('uncaughtException', (e) => {
  err('UNCAUGHT EXCEPTION:', e.message, e.stack);
  process.exit(1); // service manager will restart
});

process.on('unhandledRejection', (reason) => {
  err('UNHANDLED REJECTION:', reason);
});

process.on('SIGINT', () => {
  log(`Shutdown requested. Processed=${totalProcessed}, errors=${totalErrors}. Bye.`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  log(`Terminated. Processed=${totalProcessed}, errors=${totalErrors}.`);
  process.exit(0);
});

printBanner();
setInterval(poll, POLL_INTERVAL_MS);
setInterval(cleanup, CLEANUP_INTERVAL_MS);
poll();

if (playwrightChromium) {
  setInterval(pollCrawlJobs, CRAWL_POLL_INTERVAL_MS);
  pollCrawlJobs();
}
