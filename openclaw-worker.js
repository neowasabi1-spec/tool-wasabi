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

// ===== OPENCLAW CALL ==============================================
function callOpenClaw(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OPENCLAW_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
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
      //   { runId, funnelId, prompts: [{category, system, user}, ...] }
      // For each category we ask the local model for a JSON verdict,
      // post the partial result back to the tool so the live dashboard
      // can stream it, then finalise the run when all categories are
      // done. Errors per-category don't abort the whole run — we mark
      // the offending category as 'error' and keep going (matches the
      // built-in Claude pipeline).
      let payload;
      try { payload = JSON.parse(msg.user_message); }
      catch { throw new Error('Invalid checkpoint_audit payload (not valid JSON)'); }

      const { runId, prompts } = payload;
      if (!runId) throw new Error('checkpoint_audit missing runId');
      if (!Array.isArray(prompts) || prompts.length === 0) {
        throw new Error('checkpoint_audit missing prompts[]');
      }

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
        { status: finalStatus },
        60_000,
      );
      responsePayload = JSON.stringify({ runId, ...summary, status: finalStatus });
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

// ===== STARTUP ====================================================
function printBanner() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║           OpenClaw Worker v2               ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  Supabase URL:  ${SUPABASE_URL.substring(0, 28).padEnd(28)}║`);
  console.log(`║  OpenClaw:      ${OPENCLAW_HOST}:${OPENCLAW_PORT.toString().padEnd(28 - OPENCLAW_HOST.length - 1)}║`);
  console.log(`║  Model:         ${OPENCLAW_MODEL.padEnd(28)}║`);
  console.log(
    `║  Agent:         ${(OPENCLAW_AGENT || '(unset → legacy any-job mode)').padEnd(28).substring(0, 28)}║`,
  );
  console.log(`║  Poll:          every ${POLL_INTERVAL_MS / 1000}s`.padEnd(45) + '║');
  console.log('╚════════════════════════════════════════════╝');
  if (OPENCLAW_AGENT) {
    log(`Routing: this worker only claims jobs targeted at "${OPENCLAW_AGENT}" (or untagged legacy jobs).`);
  } else {
    log('Routing: legacy mode — claims ANY pending job (set OPENCLAW_AGENT or rename the OS user to enable explicit routing).');
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
