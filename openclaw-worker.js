/**
 * OpenClaw Worker - Runs on the VPS alongside OpenClaw
 * Polls Supabase for pending messages, sends them to local OpenClaw, writes responses back
 * 
 * Usage: node openclaw-worker.js
 * 
 * Requires: npm install @supabase/supabase-js (run once)
 */

const { createClient } = require('@supabase/supabase-js');
const http = require('http');

const SUPABASE_URL = 'https://bsovaojzveayoagshuuy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJzb3Zhb2p6dmVheW9hZ3NodXV5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MzUzNjIsImV4cCI6MjA4NTIxMTM2Mn0.OVgrc-9-ijgP0S7VPgcJ1EjSl4Hkumo_Tk_2aQHKTJQ';

const OPENCLAW_HOST = '127.0.0.1';
const OPENCLAW_PORT = 19001;
const OPENCLAW_API_KEY = '76d0f4b9c277c5e457d64d908fc51fe0a2e8a93664b30806';
const OPENCLAW_MODEL = 'openclaw:neo';

const POLL_INTERVAL = 3000; // 3 seconds

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function callOpenClaw(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OPENCLAW_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 2048,
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
      timeout: 120000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            resolve(data.choices?.[0]?.message?.content || '');
          } catch (e) {
            reject(new Error('Invalid JSON response: ' + body.substring(0, 200)));
          }
        } else {
          reject(new Error(`OpenClaw HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('OpenClaw timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function processMessage(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] Processing: "${msg.user_message.substring(0, 50)}..."`);

  // Mark as processing
  await supabase
    .from('openclaw_messages')
    .update({ status: 'processing' })
    .eq('id', msg.id);

  try {
    const systemPrompt = msg.system_prompt || 'You are OpenClaw, an AI assistant. Be concise and helpful. Respond in the same language as the user.';
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: msg.user_message },
    ];

    const response = await callOpenClaw(messages);

    await supabase
      .from('openclaw_messages')
      .update({
        status: 'completed',
        response,
        completed_at: new Date().toISOString(),
      })
      .eq('id', msg.id);

    console.log(`[${new Date().toLocaleTimeString()}] Completed: "${response.substring(0, 60)}..."`);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Error:`, err.message);
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
  try {
    const { data, error } = await supabase
      .from('openclaw_messages')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      console.error('Supabase error:', error.message);
      return;
    }

    if (data && data.length > 0) {
      await processMessage(data[0]);
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

// Cleanup old messages (older than 1 hour)
async function cleanup() {
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  await supabase
    .from('openclaw_messages')
    .delete()
    .lt('created_at', oneHourAgo);
}

console.log('========================================');
console.log('  OpenClaw Worker Started');
console.log(`  OpenClaw: ${OPENCLAW_HOST}:${OPENCLAW_PORT}`);
console.log(`  Polling every ${POLL_INTERVAL / 1000}s`);
console.log('  Waiting for messages...');
console.log('========================================');

setInterval(poll, POLL_INTERVAL);
setInterval(cleanup, 300000); // cleanup every 5 min
poll(); // immediate first poll
