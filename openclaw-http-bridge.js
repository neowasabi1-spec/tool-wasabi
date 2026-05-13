const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '19001', 10);

function callOpenClaw(userMessage) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), 'openclaw-msg-' + Date.now() + '.txt');
    fs.writeFileSync(tmpFile, userMessage, 'utf8');

    var safeMsg = userMessage.length > 6000 ? userMessage.substring(0, 6000) + '...' : userMessage;

    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'cmd' : 'openclaw';
    const args = isWindows
      ? ['/c', 'openclaw', 'agent', '--agent', 'main', '--message', safeMsg, '--json']
      : ['agent', '--agent', 'main', '--message', safeMsg, '--json'];
    const proc = spawn(cmd, args, {
      timeout: 600000,
      windowsHide: isWindows,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', function(d) { stdout += d.toString(); });
    proc.stderr.on('data', function(d) { stderr += d.toString(); });

    proc.on('close', function(code) {
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      if (code !== 0 && !stdout.trim()) {
        console.error('[' + ts() + '] stderr: ' + stderr);
        return reject(new Error('openclaw exit code ' + code + ': ' + stderr.substring(0, 200)));
      }
      try {
        var json = JSON.parse(stdout);
        if (json.status === 'ok' && json.result && json.result.payloads && json.result.payloads.length > 0) {
          var texts = json.result.payloads.map(function(p) { return p.text; }).filter(Boolean);
          resolve(texts.join('\n') || 'No response');
        } else if (json.error) {
          reject(new Error(json.error));
        } else {
          resolve(stdout.trim() || 'No response');
        }
      } catch(e) {
        var raw = stdout.trim();
        if (raw) { resolve(raw); } else { reject(new Error('Empty response')); }
      }
    });

    proc.on('error', function(err) {
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      reject(new Error('Failed to run openclaw: ' + err.message));
    });
  });
}

var server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'merlino', object: 'model', owned_by: 'openclaw' }] }));
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: HTTP_PORT }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        var messages = data.messages;
        if (!messages || !Array.isArray(messages)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing messages' }));
          return;
        }
        var userMsgs = messages.filter(function(m) { return m.role === 'user'; });
        var lastUser = userMsgs[userMsgs.length - 1];
        var userText = (lastUser && lastUser.content) || '';

        var context = '[Sei Merlino, AI assistant di Funnel Swiper. Hai pieni poteri: gestisci prodotti, progetti, funnel, template, clonazione pagine, analisi, compliance, quiz, branding, deploy. Rispondi nella lingua dell\'utente.]\n\n';

        var recentHistory = '';
        var nonSystemMsgs = messages.filter(function(m) { return m.role !== 'system'; });
        if (nonSystemMsgs.length > 1) {
          var hist = nonSystemMsgs.slice(-6, -1);
          for (var i = 0; i < hist.length; i++) {
            recentHistory += hist[i].role.toUpperCase() + ': ' + hist[i].content.substring(0, 200) + '\n';
          }
          if (recentHistory) recentHistory = '[Chat recente]\n' + recentHistory + '[Fine chat]\n\n';
        }

        var fullMessage = context + recentHistory + userText;

        console.log('[' + ts() + '] >> "' + userText.substring(0, 80) + '..."');

        callOpenClaw(fullMessage).then(function(content) {
          console.log('[' + ts() + '] << ' + content.substring(0, 80) + '...');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-' + crypto.randomUUID(),
            object: 'chat.completion',
            model: data.model || 'merlino',
            choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: 'stop' }]
          }));
        }).catch(function(err) {
          console.error('[' + ts() + '] ERROR: ' + err.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

function ts() { return new Date().toLocaleTimeString(); }

server.on('error', function(err) {
  console.error('SERVER ERROR: ' + err.message);
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + HTTP_PORT + ' is already in use! Try a different port.');
  }
});

process.on('uncaughtException', function(err) {
  console.error('UNCAUGHT: ' + err.message);
  console.error(err.stack);
});

server.listen(HTTP_PORT, '0.0.0.0', function() {
  console.log('==========================================');
  console.log('  OpenClaw HTTP Bridge (CLI mode)');
  console.log('  HTTP API : http://0.0.0.0:' + HTTP_PORT);
  console.log('  Method   : openclaw agent --agent main');
  console.log('  PID      : ' + process.pid);
  console.log('==========================================');
  console.log('Bridge running... (press Ctrl+C to stop)');
});

setInterval(function() {}, 60000);
