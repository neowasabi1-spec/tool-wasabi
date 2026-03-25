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
const GATEWAY_TOKEN = '';

// ── Tuning ──
const POLL_INTERVAL   = 3000;
const RECONNECT_DELAY = 5000;
const MESSAGE_TIMEOUT = 600000;
const PING_INTERVAL   = 15000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let ws = null;
let isConnected = false;
let reconnecting = false;
let pingTimer = null;

const pending = new Map();

function connectGateway() {
  if (reconnecting) return Promise.resolve();
  reconnecting = true;

  return new Promise((resolve, reject) => {
    const url = GATEWAY_TOKEN ? `${GATEWAY_URL}?token=${GATEWAY_TOKEN}` : GATEWAY_URL;

    ws = new WebSocket(url, {
      perMessageDeflate: false,
      headers: { 'Origin': 'http://localhost' },
      handshakeTimeout: 10000,
    });

    ws.on('open', () => {
      isConnected = true;
      reconnecting = false;
      console.log(`[${ts()}] Connected to Gateway`);

      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, PING_INTERVAL);

      resolve();
    });

    ws.on('pong', () => {});

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Log all incoming messages for debugging
      console.log(`[${ts()}] << ${msg.type || 'unknown'} id=${msg.id || 'none'}`);

      const id = msg.id;
      if (!id || !pending.has(id)) return;

      const entry = pending.get(id);

      if (msg.type === 'response' || msg.type === 'result') {
        clearTimeout(entry.timer);
        pending.delete(id);
        const text = msg.payload?.text || msg.result?.text || msg.data?.text || entry.chunks.join('') || JSON.stringify(msg.payload || msg.result || msg.data || '');
        entry.resolve(text);
      } else if (msg.type === 'chunk' || msg.type === 'partial' || msg.type === 'stream') {
        if (msg.payload?.text || msg.data?.text) {
          entry.chunks.push(msg.payload?.text || msg.data?.text);
        }
      } else if (msg.type === 'error') {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(new Error(msg.payload?.message || msg.error?.message || msg.message || 'Gateway error'));
      }
    });

    ws.on('close', (code, reason) => {
      isConnected = false;
      reconnecting = false;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      const reasonStr = reason ? reason.toString() : 'no reason';
      console.log(`[${ts()}] Disconnected (code=${code}, reason=${reasonStr}). Reconnecting in ${RECONNECT_DELAY / 1000}s...`);
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
  for (const [, entry] of pending) {
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

    const msg = {
      type: 'chat',
      id,
      payload: {
        text,
        context,
        options: {},
      },
    };

    console.log(`[${ts()}] >> chat id=${id} text="${text.substring(0, 50)}..."`);
    ws.send(JSON.stringify(msg));
  });
}

async function processMessage(msg) {
  console.log(`[${ts()}] Processing: "${msg.user_message.substring(0, 60)}"`);

  await supabase
    .from('openclaw_messages')
    .update({ status: 'processing' })
    .eq('id', msg.id);

  try {
    const systemPrompt =
      msg.system_prompt ||
      'You are OpenClaw, an AI assistant. Be concise and helpful. Respond in the same language as the user.';

    let history = [];
    try {
      if (msg.chat_history) {
        history = typeof msg.chat_history === 'string'
          ? JSON.parse(msg.chat_history)
          : msg.chat_history;
      }
    } catch {}

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

    console.log(`[${ts()}] Done: "${response.substring(0, 80)}"`);
  } catch (err) {
    console.error(`[${ts()}] Error: ${err.message}`);
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

function ts() { return new Date().toLocaleTimeString(); }

async function main() {
  console.log('========================================');
  console.log('  OpenClaw WebSocket Worker v2');
  console.log('  Gateway : ' + GATEWAY_URL);
  console.log('  Poll    : every ' + (POLL_INTERVAL / 1000) + 's');
  console.log('========================================');

  try {
    await connectGateway();
    setInterval(poll, POLL_INTERVAL);
    setInterval(cleanup, 300000);
    poll();
  } catch (err) {
    console.error('Failed to connect: ' + err.message);
    console.log('Retrying in ' + (RECONNECT_DELAY / 1000) + 's...');
    setTimeout(main, RECONNECT_DELAY);
  }
}

main();
