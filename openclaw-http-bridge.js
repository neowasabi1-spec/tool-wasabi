/**
 * OpenClaw HTTP-to-CLI Bridge
 * Runs on the VPS alongside OpenClaw Gateway.
 * Exposes an OpenAI-compatible HTTP API using `openclaw agent` CLI.
 *
 * Usage:  node openclaw-http-bridge.js
 * Port:   19001 (or set HTTP_PORT env var)
 */

const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '19001', 10);
const API_KEY = process.env.BRIDGE_API_KEY || '';
const REQUEST_TIMEOUT = 600000; // 10 min

function callOpenClaw(text) {
  return new Promise((resolve, reject) => {
    const args = ['agent', '--agent', 'main', '--message', text, '--json'];

    const proc = execFile('openclaw', args, {
      timeout: REQUEST_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[${ts()}] CLI stderr: ${stderr}`);
        return reject(new Error(err.message || 'openclaw agent failed'));
      }

      try {
        const json = JSON.parse(stdout);
        if (json.status === 'ok' && json.result?.payloads?.length > 0) {
          const texts = json.result.payloads.map(p => p.text).filter(Boolean);
          resolve(texts.join('\n') || 'No response');
        } else if (json.error) {
          reject(new Error(json.error));
        } else {
          resolve(stdout.trim() || 'No response');
        }
      } catch {
        const raw = stdout.trim();
        if (raw) {
          resolve(raw);
        } else {
          reject(new Error('Empty response from openclaw agent'));
        }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run openclaw: ${err.message}`));
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
    res.end(JSON.stringify({ ok: true, port: HTTP_PORT, method: 'openclaw-cli' }));
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

        const systemMsg = messages.find(m => m.role === 'system');
        const userMsgs = messages.filter(m => m.role !== 'system');
        const lastUser = userMsgs[userMsgs.length - 1];

        let prompt = '';
        if (systemMsg) prompt += `[System: ${systemMsg.content}]\n\n`;
        const history = userMsgs.slice(0, -1);
        if (history.length > 0) {
          prompt += history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n') + '\n\n';
        }
        prompt += lastUser?.content || '';

        console.log(`[${ts()}] >> ${model || 'merlino'} | "${(lastUser?.content || '').substring(0, 60)}..."`);

        const content = await callOpenClaw(prompt);

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
  console.log('  OpenClaw HTTP Bridge (CLI mode)');
  console.log(`  HTTP API : http://0.0.0.0:${HTTP_PORT}`);
  console.log(`  Method   : openclaw agent --message`);
  console.log(`  Endpoints:`);
  console.log(`    POST /v1/chat/completions`);
  console.log(`    GET  /v1/models`);
  console.log(`    GET  /health`);
  console.log('==========================================');
});
