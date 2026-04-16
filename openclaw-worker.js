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
const { URL } = require('url');

// ===== CONFIG =====================================================
const SUPABASE_URL = process.env.SUPABASE_URL
  || 'https://bsovaojzveayoagshuuy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJzb3Zhb2p6dmVheW9hZ3NodXV5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MzUzNjIsImV4cCI6MjA4NTIxMTM2Mn0.OVgrc-9-ijgP0S7VPgcJ1EjSl4Hkumo_Tk_2aQHKTJQ';

const OPENCLAW_HOST = process.env.OPENCLAW_HOST || '127.0.0.1';
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_PORT || '19001', 10);
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY
  || '76d0f4b9c277c5e457d64d908fc51fe0a2e8a93664b30806';
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || 'openclaw:neo';

const TOOL_BASE_URL = process.env.TOOL_BASE_URL
  || 'https://cloner-funnel-builder.vercel.app';

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
    const { data, error } = await supabase
      .from('openclaw_messages')
      .select('*')
      .eq('status', 'pending')
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
  console.log(`║  Poll:          every ${POLL_INTERVAL_MS / 1000}s`.padEnd(45) + '║');
  console.log('╚════════════════════════════════════════════╝');
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
