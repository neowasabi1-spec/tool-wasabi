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
const { URL } = require('url');

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
// Max output tokens. Anthropic Sonnet/Opus comfortably handles 8192;
// local OpenClaw/Trinity historically caps lower, so we keep its
// default at 4096 for compatibility. Override per-machine via env if
// you know your model handles more.
const OPENCLAW_MAX_TOKENS = parseInt(
  process.env.OPENCLAW_MAX_TOKENS
    || (OPENCLAW_BACKEND === 'anthropic' ? '8192' : '4096'),
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
const log = (...args) => console.log(`[${stamp()}]`, ...args);
const err = (...args) => console.error(`[${stamp()}] ERROR`, ...args);

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
function callToolApi(path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, TOOL_BASE_URL);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = JSON.stringify(body);

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); }
          catch { resolve({ raw: buf }); }
        } else {
          reject(new Error(`Tool API HTTP ${res.statusCode}: ${buf.substring(0, 300)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Tool API timeout after ${(timeoutMs / 1000).toFixed(0)}s`));
    });
    req.on('error', (e) => reject(new Error(`Tool API network error: ${e.message}`)));
    req.write(payload);
    req.end();
  });
}

// ===== REWRITE BATCHING ==========================================
// Quando il prompt è una richiesta di rewrite Trinity (section === 'Rewrite' o
// 'Quiz Rewrite'), il userMessage contiene un JSON array `textsForAi` che può
// essere troppo grande per la context window del modello locale. Lo splittiamo
// in chunk e aggreghiamo i risultati.

const REWRITE_BATCH_SIZE = parseInt(process.env.REWRITE_BATCH_SIZE || '15', 10);

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
  let cleaned = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const a = cleaned.indexOf('[');
  const b = cleaned.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  try {
    const parsed = JSON.parse(cleaned.substring(a, b + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const REWRITE_GAP_FILL_PASSES = parseInt(process.env.REWRITE_GAP_FILL_PASSES || '2', 10);

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

  async function runBatch(batch, label, extraSystemHint) {
    batchCount++;
    const batchUserMessage = `${beforeJson}\n${JSON.stringify(batch, null, 2)}\n${afterJson}`;
    log(`  ▸ Rewrite ${label} (${batch.length} testi)`);
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
      return;
    }
    const rewrites = extractRewritesFromAiResponse(raw);
    for (const rw of rewrites) {
      if (!rw || typeof rw.id !== 'number') continue;
      if (typeof rw.rewritten !== 'string') continue;
      const trimmed = rw.rewritten.trim();
      if (!trimmed) continue;
      // Reject "echo": se il modello restituisce identico all'originale e il
      // testo non è breve/strutturale, non lo registriamo così verrà ritentato
      // nel pass di echo-fill.
      const original = idToOriginal.get(rw.id);
      if (original && trimmed === original && original.length > 20) {
        // tieni solo se non avevamo già una rewrite per quell'id (così non
        // peggioriamo una rewrite buona di un pass precedente)
        if (!idToRewrite.has(rw.id)) {
          // marker speciale: stringa vuota = "vista ma echo, da ritentare"
          // NB: usiamo un Map separato per i pending, per non confondere con missing.
        }
        continue;
      }
      idToRewrite.set(rw.id, trimmed);
    }
  }

  // Pass principale.
  for (let i = 0; i < total; i += REWRITE_BATCH_SIZE) {
    const batch = texts.slice(i, i + REWRITE_BATCH_SIZE);
    const idxFrom = i + 1;
    const idxTo = Math.min(i + REWRITE_BATCH_SIZE, total);
    await runBatch(batch, `batch ${batchCount + 1} (${idxFrom}-${idxTo}/${total})`);
  }

  // Gap-fill: il modello locale a volte salta degli id O risponde con echo
  // (= testo originale identico). In entrambi i casi ritentiamo solo i mancanti
  // con un hint di sistema più aggressivo e batch più piccoli.
  for (let pass = 1; pass <= REWRITE_GAP_FILL_PASSES; pass++) {
    const missing = texts.filter((t) => !idToRewrite.has(t.id));
    if (missing.length === 0) break;
    const echoHint = pass === 1
      ? 'Hai appena restituito il testo originale identico per QUESTI id. È vietato. Riscrivili davvero per il prodotto target.'
      : 'ULTIMO TENTATIVO: per OGNI id qui sotto produci un "rewritten" semanticamente diverso dall\'"text". Se il testo è generico, riformulalo dal punto di vista del prodotto target con parole sue.';
    log(`  ▸ Gap-fill pass ${pass}: ${missing.length} testi ancora mancanti (echo o skipped)`);
    const fillBatchSize = Math.max(5, Math.floor(REWRITE_BATCH_SIZE / 2));
    for (let i = 0; i < missing.length; i += fillBatchSize) {
      const slice = missing.slice(i, i + fillBatchSize);
      await runBatch(slice, `gap-fill p${pass} (${slice.length} testi)`, echoHint);
    }
  }

  // Final fallback: per i testi che dopo tutti i pass restano senza rewrite,
  // li includiamo comunque nel response con `rewritten = original` così almeno
  // applyRewrites server-side ha una entry per ogni id (e lo status route può
  // contarli). Senza questo, alcuni testi resterebbero `missing` per sempre.
  for (const t of texts) {
    if (!idToRewrite.has(t.id) && idToOriginal.has(t.id)) {
      idToRewrite.set(t.id, idToOriginal.get(t.id));
    }
  }

  const allRewrites = [];
  for (const [id, rewritten] of idToRewrite) {
    allRewrites.push({ id, rewritten });
  }
  const stillMissing = texts.length - idToRewrite.size;
  log(
    `  ▸ Rewrite done: ${idToRewrite.size}/${total} testi riscritti in ${batchCount} batch`
    + (stillMissing > 0 ? ` (${stillMissing} ancora mancanti dopo gap-fill)` : ''),
  );
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
        log(`  · prep: fetching pages + building prompts for funnel ${funnelId}`);
        let prep;
        try {
          prep = await callToolApi(
            `/api/checkpoint/${funnelId}/openclaw-prep`,
            // Forward runId so the prep step can write [stage] hints
            // into funnel_checkpoints.error during the 30-90s page-
            // fetch / SPA-render window. The dashboard polling client
            // reads those and shows them in the live activity log so
            // the user sees what's happening instead of staring at
            // "0/3 step completati" for a minute.
            { categories, brandProfile, runId },
            300_000, // 5 min: SPA fetch can be slow on first visit
          );
        } catch (e) {
          err(`  ✗ openclaw-prep failed: ${e.message}`);
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
        for (const p of prompts) {
          const cat = p.category;
          log(`  ▸ checkpoint ${cat}`);
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
          } catch (e) {
            err(`  ✗ checkpoint ${cat} failed:`, e.message);
            await callToolApi(
              `/api/checkpoint/runs/${runId}/openclaw-category`,
              { category: cat, ok: false, error: e.message },
              60_000,
            ).catch(() => { /* don't crash on follow-up failure */ });
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

const QUIZ_NEXT_PATTERN_SOURCE =
  'next|continue|avanti|continua|→|submit|get\\s*(my|your)?\\s*result|see\\s*result|claim|claim\\s*discount|start|inizia|scopri|prossimo|vai\\s*avanti|ottieni|scopri\\s*(la\\s*)?(tua\\s*)?(offerta|risultato)|next\\s*step|go|vai|proceed|siguiente|siguir|weiter|suivant|continuer|próximo|continuar';

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
const CRAWL_DEFAULT_MAX_STEPS = 25;
const CRAWL_POLL_INTERVAL_MS = 4000;

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

    const PRIMARY_SEL =
      'button, [role="button"], input[type="submit"], input[type="button"], a[class*="btn"], a[class*="button"], a[class*="cta"], a[class*="next"], [class*="cta"], [class*="next-button"]';
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
      let priority = 0;
      if (pattern.test(text)) priority += 100;
      if (el.type === 'submit') priority += 30;
      if (el.tagName === 'BUTTON') priority += 10;
      if (/btn|button|cta|next|submit|continue|primary/i.test(el.className || '')) priority += 8;
      if (rect.top > viewportH * 0.4) priority += 5;
      if (rect.top >= 0 && rect.bottom <= viewportH) priority += 2;
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
    50,
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
        const inventory = await page
          .evaluate(() => {
            const out = [];
            const sel =
              'button, [role="button"], input[type="submit"], input[type="button"], a, [class*="btn"], [class*="cta"], [class*="answer"], [class*="option"], [class*="choice"], [onclick]';
            document.querySelectorAll(sel).forEach((el) => {
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              const visible =
                r.width >= 5 &&
                r.height >= 5 &&
                s.visibility !== 'hidden' &&
                s.display !== 'none' &&
                s.opacity !== '0';
              if (!visible) return;
              const text = ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').trim().slice(0, 60);
              if (!text && el.tagName !== 'BUTTON') return;
              out.push({
                tag: el.tagName.toLowerCase(),
                cls: (el.className || '').toString().slice(0, 60),
                w: Math.round(r.width),
                h: Math.round(r.height),
                text: text || '(empty)',
                disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
              });
              if (out.length >= 30) return;
            });
            return out;
          })
          .catch(() => []);
        log(`  · no clickable advance found, stopping. DOM inventory at this step:`);
        for (const it of inventory.slice(0, 20)) {
          log(`      [${it.tag}] "${it.text}" — ${it.w}x${it.h} ${it.disabled ? '(disabled)' : ''} class="${it.cls}"`);
        }
        if (inventory.length > 20) {
          log(`      ... +${inventory.length - 20} more elements not shown`);
        }
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
          break;
        }
      } else {
        consecutiveSame = 0;
      }
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
