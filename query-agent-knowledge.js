#!/usr/bin/env node
/**
 * query-agent-knowledge.js
 *
 * Chiede a Neo (locale via OpenClaw) o Morfeo (Anthropic via API)
 * di elencare TUTTA la knowledge che hanno effettivamente in casa:
 *  - archivi prodotti (cosa hanno indicizzato, prodotti per settore)
 *  - knowledge base di copywriting (quali libri / autori / framework)
 *  - tecniche di scrittura che sanno applicare (per nome esplicito)
 *  - capacita' RAG / lookup esterno
 *  - dati di mercato / market research storica
 *  - brief di progetti precedenti
 *  - swipe file storici
 *
 * Cosi' invece di pretendere che l'utente fornisca brief / MR / tecniche
 * a mano dal tool, il worker puo' chiedere al singolo agente di
 * pescare dai SUOI archivi.
 *
 * Uso (su Windows in PowerShell):
 *   node query-agent-knowledge.js                  # interroga il backend default (Neo)
 *   $env:OPENCLAW_BACKEND="anthropic"; node ...    # interroga Morfeo
 *
 * Salva la risposta in `agent-knowledge-<agent>.txt` accanto allo
 * script, cosi' la puoi rileggere/condividere senza dover ri-eseguire.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OPENCLAW_HOST = process.env.OPENCLAW_HOST || '127.0.0.1';
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_PORT || '18789', 10);
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY
  || 'ba893c2470e9f12b281ab1031746b5f177b14a746143b1ab';
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || 'openclaw/trinity';
const OPENCLAW_BACKEND = (process.env.OPENCLAW_BACKEND || 'openai-compat').toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.OPENCLAW_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
const TIMEOUT_MS = 5 * 60 * 1000;

function detectAgentName() {
  const env = (process.env.OPENCLAW_AGENT || '').trim();
  if (env) return env.replace(/^openclaw:/, '');
  if (OPENCLAW_BACKEND === 'anthropic') return 'morfeo';
  const name = `${os.userInfo().username || ''} ${os.hostname() || ''}`.toLowerCase();
  if (/morfeo|morpheus/.test(name)) return 'morfeo';
  return 'neo';
}

const AGENT_NAME = detectAgentName();

function callOpenAICompat(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OPENCLAW_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 16384,
    });
    const req = http.request({
      hostname: OPENCLAW_HOST,
      port: OPENCLAW_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENCLAW_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            resolve(data.choices?.[0]?.message?.content || '');
          } catch (e) {
            reject(new Error('Bad JSON: ' + body.substring(0, 300)));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 300)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout ${TIMEOUT_MS}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function callAnthropic(messages) {
  return new Promise((resolve, reject) => {
    const sysParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const conv = messages.filter((m) => m.role !== 'system');
    const payload = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8192,
      temperature: 0.3,
      system: sysParts.join('\n\n'),
      messages: conv.map((m) => ({ role: m.role, content: m.content })),
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
            resolve(text);
          } catch (e) {
            reject(new Error('Bad JSON: ' + body.substring(0, 300)));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 300)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout ${TIMEOUT_MS}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const callAgent = OPENCLAW_BACKEND === 'anthropic' ? callAnthropic : callOpenAICompat;

const SYSTEM_PROMPT = `Sei ${AGENT_NAME.toUpperCase()}, un agente AI specializzato in direct-response copywriting con accesso ad archivi prodotti, knowledge base, RAG locale, conversazioni passate, file di progetto, esperienze pregresse. Quando ti chiedono di descrivere cosa hai a disposizione, sei ONESTO e CONCRETO: dici quello che hai davvero, non quello che potresti avere in teoria.`;

const USER_PROMPT = `Devo capire CONCRETAMENTE cosa hai disponibile nei tuoi archivi e nella tua knowledge interna, perche' il tool deve sapere su cosa puo' contare quando ti chiede di riscrivere copy.

Rispondimi SCHIETTO, senza preamboli, in italiano, suddividendo in sezioni cosi':

== ARCHIVI PRODOTTI ==
Hai prodotti indicizzati? Quanti? Per quali settori (salute/integratori, beauty, finanza, info-prodotti, e-commerce fisico, software/SaaS, ecc.)? Sai accedere a dati strutturati per ogni prodotto (nome, ingredienti/feature, prezzo, claim approvati, USP, target avatar, recensioni, social proof)? Se hai esempi reali nominali, citane 5-10. Se NON hai archivi, dillo chiaramente.

== KNOWLEDGE BASE COPYWRITING ==
Quali AUTORI / LIBRI hai indicizzati e da cui sai tirare fuori passaggi, esempi, formule? Specifici per nome:
- Stefan Georgi / RMBC method?
- Eugene Schwartz / Breakthrough Advertising / awareness levels?
- Gary Halbert / Boron Letters?
- John Caples / Tested Advertising Methods?
- Gary Bencivenga / Bencivenga Bullets?
- David Ogilvy / Ogilvy on Advertising?
- John Carlton / killer headlines?
- Dan Kennedy / Magnetic Marketing / NO-BS series?
- Joe Sugarman / Adweek Copywriting Handbook?
- Claude Hopkins / Scientific Advertising?
- Robert Collier / Letter Book?
- Jay Abraham / preeminence + USP?
- Frank Kern, Russell Brunson, Joe Karbo, Ben Settle, Andre Chaperon, Brian Kurtz?
- Sultanic Framework / archetipi narrativi?
Per ognuno: lo HAI o NO? Se si', a che livello (sai parafrasare formule / sai citare passaggi / sai applicare il framework end-to-end)?

== FRAMEWORK CHE SAI APPLICARE END-TO-END ==
Elenca i framework di copywriting che sai applicare in modo strutturato (PAS, AIDA, AIDCA, FAB, BAB, QUEST, HSO, 4P, Big Idea, StoryBrand, RMBC, Pico hook, ecc.) — per ognuno: lo conosci a memoria si/no, e in che casi e' meglio usarlo.

== SWIPE FILE / ESEMPI VINCENTI ==
Hai un archivio di sales letter, VSL, landing page storiche di cui ricordi la struttura e i pattern vincenti (Bencivenga, Halbert, Boardroom, Agora, Phillips Publishing, ClickBank top performer, ecc.)? Se si', stima quanti.

== MARKET RESEARCH / DATI DI MERCATO ==
Hai dati storici su mercati specifici (es. prezzi medi settore X, awareness level tipico audience Y, big claim del settore Z)? Per quali settori sei piu' forte?

== BRIEF DI PROGETTI PRECEDENTI ==
Hai brief di progetti gia' lavorati che potresti riutilizzare come reference? Se si', come li indicizzi (per cliente / per settore / per tipologia di funnel)?

== CAPACITA' RAG / LOOKUP ESTERNO ==
Puoi cercare in tempo reale in fonti esterne (web, archivi proprietari, database)? Se si', quali tool / API hai esposti?

== LIMITI ==
Cosa NON hai e che il tool dovrebbe darti dal suo lato (es. "il tool deve passarmi sempre il URL del competitor", "il tool deve dirmi il prezzo target perche' io non lo so", "non ho dati FDA aggiornati", ecc.)?

Massimo 1500 parole. Sii ONESTO: se non hai qualcosa, dillo. Non promettere capacita' che non hai, perche' il codice del tool poi si baserebbe su quelle e fallirebbe.`;

(async () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Querying ${AGENT_NAME.toUpperCase()} (backend: ${OPENCLAW_BACKEND})…`);
  console.log(`${'='.repeat(60)}\n`);
  const t0 = Date.now();
  try {
    const reply = await callAgent([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT },
    ]);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const out = `# AGENT KNOWLEDGE INVENTORY — ${AGENT_NAME.toUpperCase()}\n# Generated: ${new Date().toISOString()}\n# Elapsed: ${elapsed}s\n# Backend: ${OPENCLAW_BACKEND}\n# Model: ${OPENCLAW_BACKEND === 'anthropic' ? ANTHROPIC_MODEL : OPENCLAW_MODEL}\n\n${reply.trim()}\n`;
    const outFile = path.join(__dirname, `agent-knowledge-${AGENT_NAME}.txt`);
    fs.writeFileSync(outFile, out, 'utf8');
    console.log(reply.trim());
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Saved to: ${outFile}`);
    console.log(`Elapsed: ${elapsed}s`);
    console.log(`${'='.repeat(60)}\n`);
  } catch (e) {
    console.error(`\nERROR querying ${AGENT_NAME}: ${e.message}\n`);
    process.exit(1);
  }
})();
