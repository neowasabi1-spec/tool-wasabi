var http = require('http');
var BRIDGE_URL = 'http://127.0.0.1:19001/v1/chat/completions';
var API_KEY = 'a353475b70538480030b744771524d183521a46ab8db7b02a2846d1103bc5734';
var PORT = 3333;

var HTML_PAGE = '<!DOCTYPE html>\n' +
'<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' +
'<title>Merlino Chat</title>\n' +
'<style>\n' +
'*{margin:0;padding:0;box-sizing:border-box}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;height:100vh;display:flex;flex-direction:column}\n' +
'.header{background:linear-gradient(135deg,#ea580c,#dc2626);padding:16px 24px;display:flex;align-items:center;gap:12px;box-shadow:0 2px 12px rgba(0,0,0,.3)}\n' +
'.header svg{width:28px;height:28px;fill:#fff}\n' +
'.header h1{font-size:18px;font-weight:700;color:#fff}\n' +
'.header .dot{width:10px;height:10px;border-radius:50%;background:#4ade80;margin-left:8px;animation:pulse 2s infinite}\n' +
'@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}\n' +
'.messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px}\n' +
'.msg{max-width:80%;padding:12px 16px;border-radius:16px;font-size:14px;line-height:1.6;word-wrap:break-word;white-space:pre-wrap}\n' +
'.msg.user{align-self:flex-end;background:linear-gradient(135deg,#ea580c,#dc2626);color:#fff;border-bottom-right-radius:4px}\n' +
'.msg.assistant{align-self:flex-start;background:#1e293b;color:#e2e8f0;border-bottom-left-radius:4px;border:1px solid #334155}\n' +
'.msg.system{align-self:center;background:#7f1d1d;color:#fca5a5;font-size:12px;border-radius:8px;text-align:center}\n' +
'.msg.thinking{align-self:flex-start;background:#1e293b;color:#94a3b8;font-style:italic;border:1px solid #334155;border-bottom-left-radius:4px}\n' +
'.input-bar{padding:16px 20px;background:#1e293b;border-top:1px solid #334155;display:flex;gap:12px}\n' +
'.input-bar input{flex:1;padding:12px 16px;border-radius:12px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px;outline:none}\n' +
'.input-bar input:focus{border-color:#ea580c}\n' +
'.input-bar input::placeholder{color:#64748b}\n' +
'.input-bar button{padding:12px 24px;border-radius:12px;border:none;background:linear-gradient(135deg,#ea580c,#dc2626);color:#fff;font-weight:700;font-size:14px;cursor:pointer;transition:opacity .2s}\n' +
'.input-bar button:hover{opacity:.9}\n' +
'.input-bar button:disabled{opacity:.5;cursor:not-allowed}\n' +
'</style></head><body>\n' +
'<div class="header">\n' +
'<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>\n' +
'<h1>Merlino</h1><div class="dot"></div>\n' +
'</div>\n' +
'<div class="messages" id="msgs"></div>\n' +
'<div class="input-bar">\n' +
'<input id="inp" placeholder="Scrivi a Merlino..." autocomplete="off" />\n' +
'<button id="btn" onclick="send()">Invia</button>\n' +
'</div>\n' +
'<script>\n' +
'var msgs=document.getElementById("msgs"),inp=document.getElementById("inp"),btn=document.getElementById("btn");\n' +
'var history=[];\n' +
'function addMsg(role,text){var d=document.createElement("div");d.className="msg "+role;d.textContent=text;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d;}\n' +
'inp.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});\n' +
'async function send(){\n' +
'var text=inp.value.trim();if(!text)return;\n' +
'inp.value="";btn.disabled=true;\n' +
'addMsg("user",text);\n' +
'history.push({role:"user",content:text});\n' +
'var thinking=addMsg("thinking","Merlino sta pensando...");\n' +
'try{\n' +
'var res=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:history})});\n' +
'var data=await res.json();\n' +
'if(data.error)throw new Error(data.error);\n' +
'var reply=data.choices&&data.choices[0]&&data.choices[0].message?data.choices[0].message.content:(data.content||"Nessuna risposta");\n' +
'thinking.remove();\n' +
'addMsg("assistant",reply);\n' +
'history.push({role:"assistant",content:reply});\n' +
'}catch(err){thinking.remove();addMsg("system","Errore: "+err.message);}\n' +
'btn.disabled=false;inp.focus();\n' +
'}\n' +
'addMsg("assistant","Ciao! Sono Merlino. Come posso aiutarti?");\n' +
'inp.focus();\n' +
'</script></body></html>';

var server = http.createServer(function(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/chat')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: PORT }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var parsed = JSON.parse(body);
        var messages = parsed.messages || [];

        var context = '[Sei Merlino, AI assistant di Funnel Swiper. Hai pieni poteri: gestisci prodotti, progetti, funnel, template, clonazione pagine, analisi, compliance, quiz, branding, deploy. Rispondi nella lingua dell\'utente.]\n\n';

        var recent = messages.slice(-8);
        var fullMessages = [
          { role: 'system', content: context },
        ].concat(recent);

        var postData = JSON.stringify({
          model: 'merlino',
          messages: fullMessages,
          max_tokens: 4096,
        });

        var bridgeReq = http.request(BRIDGE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + API_KEY,
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 300000,
        }, function(bridgeRes) {
          var data = '';
          bridgeRes.on('data', function(chunk) { data += chunk; });
          bridgeRes.on('end', function() {
            res.writeHead(bridgeRes.statusCode || 200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(data);
          });
        });

        bridgeReq.on('error', function(err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bridge error: ' + err.message }));
        });

        bridgeReq.on('timeout', function() {
          bridgeReq.destroy();
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Merlino timeout (5 min)' }));
        });

        bridgeReq.write(postData);
        bridgeReq.end();
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request: ' + err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║       MERLINO CHAT - porta ' + PORT + '          ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log('  ║  Apri nel browser:                      ║');
  console.log('  ║  http://38.247.186.84:' + PORT + '              ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});

server.on('error', function(err) {
  console.error('Server error:', err.message);
});

process.on('uncaughtException', function(err) {
  console.error('Uncaught:', err.message);
});
