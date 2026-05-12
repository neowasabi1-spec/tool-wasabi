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

// Anthropic Messages API call. Used by Morfeo on the Mac Mini —
// no local LLM, just an Anthropic API key. We translate the
// OpenAI-shaped `messages` array into the Anthropic format:
//   - the first/concatenated `role: 'system'` entries become the
//     top-level `system` field
//   - everything else stays as { role, content } in `messages`
//   - the response's `content[].text` blocks are joined back into
//     a single string so the rest of the worker is unchanged.
function callAnthropic(messages) {
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
            const reply = await callOpenClaw([
              { role: 'system', content: p.system },
              { role: 'user', content: p.user },
            ]);
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

const CRAWL_NAV_TIMEOUT_MS = 120_000;
const CRAWL_STEP_WAIT_MS = 2500;
const CRAWL_TRANSITION_MS = 1500;
const CRAWL_SAME_FINGERPRINT_MAX = 3;
const CRAWL_DEFAULT_MAX_STEPS = 25;
const CRAWL_POLL_INTERVAL_MS = 4000;
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

    return filled;
  });
}

async function clickCrawlAdvance(page, patternSource) {
  return page.evaluate((src) => {
    const pattern = new RegExp(src, 'i');
    const candidates = [];
    const els = document.querySelectorAll(
      'button, [role="button"], input[type="submit"], a[class*="btn"], a[class*="button"], label[for], input[type="radio"]:not(:checked), [class*="option"]:not([aria-selected="true"]), [class*="answer"], [class*="choice"], [class*="cta"], [class*="next"]',
    );
    els.forEach((el) => {
      const text = (el.innerText || '').trim() || el.value || el.placeholder || '';
      if (!text || text.length > 200) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) return;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return;
      let priority = 0;
      if (pattern.test(text)) priority = 10;
      else if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') priority = 6;
      else if (el.type === 'radio') priority = 5;
      else if (el.type === 'submit') priority = 7;
      else if (/btn|button|cta|next|submit/i.test(el.className || '')) priority = 4;
      else if (el.tagName === 'LABEL') priority = 3;
      else if (/option|answer|choice/i.test(el.className || '')) priority = 2;
      else priority = 1;
      candidates.push({ el, priority });
    });
    candidates.sort((a, b) => b.priority - a.priority);
    for (const { el } of candidates) {
      try {
        el.click();
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
    await page.waitForLoadState('networkidle').catch(() => {});

    let consecutiveSame = 0;

    while (steps.length < maxSteps) {
      const fp = await getQuizFingerprint(page).catch(() => '');
      const title = await page.title().catch(() => '');
      const url = page.url();

      steps.push({
        stepIndex: steps.length + 1,
        url,
        title,
        timestamp: new Date().toISOString(),
        isQuizStep: true,
      });
      log(`  · step ${steps.length}/${maxSteps}: ${url}`);
      await updateCrawlJob(jobId, {
        currentStep: steps.length,
        totalSteps: maxSteps,
      });

      if (isCheckoutLikePage(url, title)) {
        log(`  · checkout-like page detected, stopping`);
        break;
      }

      await fillCrawlFormFields(page).catch(() => 0);
      const clicked = await clickCrawlAdvance(page, QUIZ_NEXT_PATTERN_SOURCE).catch(
        () => false,
      );
      if (!clicked) {
        log(`  · no clickable advance found, stopping`);
        break;
      }

      await new Promise((r) => setTimeout(r, CRAWL_STEP_WAIT_MS));
      const newFp = await getQuizFingerprint(page).catch(() => '');
      if (newFp === fp) {
        await new Promise((r) => setTimeout(r, CRAWL_TRANSITION_MS));
        const retry = await getQuizFingerprint(page).catch(() => '');
        if (retry === fp) {
          consecutiveSame++;
          if (consecutiveSame >= CRAWL_SAME_FINGERPRINT_MAX) {
            log(`  · stuck on same fingerprint ${consecutiveSame}× — stopping`);
            break;
          }
        } else {
          consecutiveSame = 0;
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
    const { data, error } = await supabase
      .from('funnel_crawl_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);
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
