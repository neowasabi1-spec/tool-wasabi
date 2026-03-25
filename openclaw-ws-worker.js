/**
 * OpenClaw WebSocket Worker - Runs on the VPS alongside OpenClaw Gateway
 * Polls Supabase for pending messages, sends them to OpenClaw Gateway via WebSocket,
 * writes responses back to Supabase.
 *
 * Usage: node openclaw-ws-worker.js
 *
 * Requires: npm install @supabase/supabase-js ws
 */

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const crypto = require('crypto');

// ── Supabase ──
const SUPABASE_URL = 'https://bsovaojzveayoagshuuy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJzb3Zhb2p6dmVheW9hZ3NodXV5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MzUzNjIsImV4cCI6MjA4NTIxMTM2Mn0.OVgrc-9-ijgP0S7VPgcJ1EjSl4Hkumo_Tk_2aQHKTJQ';

// ── OpenClaw Gateway (WebSocket) ──
const GATEWAY_URL = 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = '';  // leave empty if auth mode is "none"

// ── Tuning ──
const POLL_INTERVAL   = 3000;      // 3 s
const RECONNECT_DELAY = 5000;      // 5 s
const MESSAGE_TIMEOUT = 600000;    // 10 min (agent tasks can be slow)

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let ws = null;
let isConnected = false;
let reconnecting = false;

// Map of pending request-id → { resolve, reject, timer, chunks[] }
const pending = new Map();

// ────────────────────────── WebSocket helpers ──────────────────────────

function connectGateway() {
  if (reconnecting) return;
  reconnecting = true;

  return new Promise((resolve, reject) => {
    const url = GATEWAY_TOKEN
      ? `${GATEWAY_URL}?token=${GATEWAY_TOKEN}`
      : GATEWAY_URL;

    ws = new WebSocket(url);

    ws.on('open', () => {
      isConnected = true;
      reconnecting = false;
      console.log(`[${ts()}] ✓ Connected to Gateway ${GATEWAY_URL}`);
      resolve();
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      const id = msg.id;
      if (!id || !pending.has(id)) return;

      const entry = pending.get(id);

      if (msg.type === 'response') {
        // Final response
        clearTimeout(entry.timer);
        pending.delete(id);
        const text = msg.payload?.text || entry.chunks.join('');
        entry.resolve(text);
      } else if (msg.type === 'chunk' || msg.type === 'partial') {
        // Streaming chunk — accumulate
        if (msg.payload?.text) entry.chunks.push(msg.payload.text);
      } else if (msg.type === 'error') {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(new Error(msg.payload?.message || 'Gateway error'));
      }
    });

    ws.on('close', () => {
      isConnected = false;
      reconnecting = false;
      console.log(`[${ts()}] Gateway disconnected — reconnecting in ${RECONNECT_DELAY / 1000}s …`);
      rejectAllPending('Gateway connection closed');
      setTimeout(() => connectGateway().catch(() => {}), RECONNECT_DELAY);
    });

    ws.on('error', (err) => {
      console.error(`[${ts()}] WS error: ${err.message}`);
      if (!isConnected) {
        reconnecting = false;
        reject(err);
      }
    });
  });
}

function rejectAllPending(reason) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

function sendChat(text, context = {}) {
  return new Promise((resolve, reject) => {
    if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('Not connected to Gateway'));
    }

    const id = crypto.randomUUID();

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Gateway response timeout'));
    }, MESSAGE_TIMEOUT);

    pending.set(id, { resolve, reject, timer, chunks: [] });

    ws.send(JSON.stringify({
      type: 'chat',
      id,
      payload: {
        text,
        context,
        options: {},
      },
    }));
  });
}

// ────────────────────────── Message processing ──────────────────────────

async function processMessage(msg) {
  console.log(`[${ts()}] Processing: "${msg.user_message.substring(0, 60)}…"`);

  await supabase
    .from('openclaw_messages')
    .update({ status: 'processing' })
    .eq('id', msg.id);

  try {
    const systemPrompt =
      msg.system_prompt ||
      'You are OpenClaw, an AI assistant. Be concise and helpful. Respond in the same language as the user. You have full access to all your skills including browser navigation, URL analysis, and any other tool available to you. Use them freely when the user requests it.';

    let history = [];
    try {
      if (msg.chat_history) {
        history = typeof msg.chat_history === 'string'
          ? JSON.parse(msg.chat_history)
          : msg.chat_history;
      }
    } catch { /* ignore parse errors */ }

    const context = {
      systemPrompt,
      history: Array.isArray(history) ? history : [],
    };

    const response = await sendChat(msg.user_message, context);

    await supabase
      .from('openclaw_messages')
      .update({
        status: 'completed',
        response,
        completed_at: new Date().toISOString(),
      })
      .eq('id', msg.id);

    console.log(`[${ts()}] ✓ Done: "${response.substring(0, 80)}…"`);
  } catch (err) {
    console.error(`[${ts()}] ✗ Error: ${err.message}`);
    await supabase
      .from('openclaw_messages')
      .update({
        status: 'error',
        error_message: err.message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', msg.id);
  }
}

// ────────────────────────── Polling ──────────────────────────

async function poll() {
  if (!isConnected) return;

  try {
    const { data, error } = await supabase
      .from('openclaw_messages')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) { console.error('Supabase poll error:', error.message); return; }
    if (data && data.length > 0) await processMessage(data[0]);
  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

async function cleanup() {
  const cutoff = new Date(Date.now() - 3600000).toISOString();
  await supabase.from('openclaw_messages').delete().lt('created_at', cutoff);
}

// ────────────────────────── Main ──────────────────────────

function ts() { return new Date().toLocaleTimeString(); }

async function main() {
  console.log('========================================');
  console.log('  OpenClaw WebSocket Worker');
  console.log(`  Gateway : ${GATEWAY_URL}`);
  console.log(`  Poll    : every ${POLL_INTERVAL / 1000}s`);
  console.log('========================================');

  try {
    await connectGateway();
    setInterval(poll, POLL_INTERVAL);
    setInterval(cleanup, 300000);
    poll();
  } catch (err) {
    console.error(`Failed to connect: ${err.message}`);
    console.log(`Retrying in ${RECONNECT_DELAY / 1000}s …`);
    setTimeout(main, RECONNECT_DELAY);
  }
}

main();
