const https = require('http');

const data = JSON.stringify({
  model: 'openclaw:neo',
  messages: [{ role: 'user', content: 'ciao, rispondi con una parola' }]
});

const options = {
  hostname: '69.197.168.23',
  port: 19001,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer 76d0f4b9c277c5e457d64d908fc51fe0a2e8a93664b30806',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  },
  timeout: 15000
};

const req = https.request(options, (res) => {
  console.log('STATUS:', res.statusCode);
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => { console.log('RESPONSE:', body); });
});

req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); });
req.on('error', (e) => { console.log('ERROR:', e.message); });
req.write(data);
req.end();
