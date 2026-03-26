/**
 * OpenClaw HTTP-to-WebSocket Bridge
 * Runs on the VPS alongside OpenClaw Gateway.
 * Exposes an OpenAI-compatible HTTP API that translates to WebSocket calls.
 *
 * Usage:  node openclaw-http-bridge.js
 * Port:   19001 (or set HTTP_PORT env var)
 *
 * Requires: npm install ws
 */

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '19001', 10);
const GATEWAY_WS = process.env.GATEWAY_WS || 'ws://127.0.0.1:18789';
const API_KEY = process.env.BRIDGE_API_KEY || '';
const REQUEST_TIMEOUT = 600000; // 10 min

function sendToGateway(messages) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_WS, {
      perMessageDeflate: false,
      headers: { 'Origin': 'http://localhost' },
      handshakeTimeout: 10000,
    });

    const id = crypto.randomUUID();
    const chunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error('Gateway response timeout'));
      }
    }, REQUEST_TIMEOUT);

    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(text);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      reject(err);
    };

    ws.on('open', () => {
      const systemMsg = messages.find(m => m.role === 'system');
      const userMsgs = messages.filter(m => m.role !== 'system');
      const lastUser = userMsgs[userMsgs.length - 1];
      const history = userMsgs.slice(0, -1);

      const msg = {
        type: 'chat',
        id,
        payload: {
          text: lastUser?.content || '',
          context: {
            systemPrompt: systemMsg?.content || '',
            history: history.map(m => ({ role: m.role, content: m.content })),
          },
          options: {},
        },
      };

      ws.send(JSON.stringify(msg));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.id && msg.id !== id) return;

      if (msg.type === 'response' || msg.type === 'result') {
        const text = msg.payload?.text || msg.result?.text || msg.data?.text || chunks.join('') || JSON.stringify(msg.payload || msg.result || msg.data || '');
        finish(text);
      } else if (msg.type === 'chunk' || msg.type === 'partial' || msg.type === 'stream') {
        if (msg.payload?.text || msg.data?.text) {
          chunks.push(msg.payload?.text || msg.data?.text);
        }
      } else if (msg.type === 'error') {
        fail(new Error(msg.payload?.message || msg.error?.message || msg.message || 'Gateway error'));
      } else if (msg.type === 'agent:lifecycle' && msg.payload?.event === 'done') {
        if (chunks.length > 0) finish(chunks.join(''));
      }
    });

    ws.on('close', (code, reason) => {
      if (!settled) {
        if (chunks.length > 0) {
          finish(chunks.join(''));
        } else {
          fail(new Error(`Gateway closed (code=${code}, reason=${reason?.toString() || 'none'})`));
        }
      }
    });

    ws.on('error', (err) => {
      fail(new Error(`WebSocket error: ${err.message}`));
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (API_KEY && req.headers.authorization) {
    const token = req.headers.authorization.replace('Bearer ', '');
    if (token !== API_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'merlino', object: 'model', owned_by: 'openclaw' }],
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, gateway: GATEWAY_WS, port: HTTP_PORT }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { messages, model } = JSON.parse(body);
        if (!messages || !Array.isArray(messages)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing messages array' }));
          return;
        }

        console.log(`[${ts()}] >> ${model || 'merlino'} | ${messages.length} msgs | "${(messages[messages.length - 1]?.content || '').substring(0, 60)}..."`);

        const content = await sendToGateway(messages);

        console.log(`[${ts()}] << ${content.substring(0, 80)}...`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: 'chat.completion',
          model: model || 'merlino',
          choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          }],
        }));
      } catch (err) {
        console.error(`[${ts()}] ERROR: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

function ts() { return new Date().toLocaleTimeString(); }

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  OpenClaw HTTP-to-WebSocket Bridge');
  console.log(`  HTTP API  : http://0.0.0.0:${HTTP_PORT}`);
  console.log(`  Gateway WS: ${GATEWAY_WS}`);
  console.log(`  Endpoints :`);
  console.log(`    POST /v1/chat/completions`);
  console.log(`    GET  /v1/models`);
  console.log(`    GET  /health`);
  console.log('==========================================');
});
