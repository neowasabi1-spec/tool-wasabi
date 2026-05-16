// worker-lib/knowledge-kb.js
//
// Port JS puro di src/knowledge/copywriting/index.ts.
// Legge i file markdown sotto src/knowledge/copywriting/raw/ (i raw
// restano in repo, sono solo dati). ZERO chiamate HTTP.
//
// Mantenere allineato all'index TS se cambiano i sorgenti.

const fs = require('node:fs');
const path = require('node:path');

const KB_DIR = path.join(__dirname, '..', 'src', 'knowledge', 'copywriting', 'raw');
const MAX_TIER2_TOKENS = 35000;

const SOURCES = [
  // ── Tier 1 — always loaded ──
  { id: 'cos-engine',                title: 'Conversion Operating System (COS Engine)',                 filename: 'cos-engine.md',                  tier: 1, approxTokens: 17000 },
  { id: 'tony-flores-mechanisms',    title: 'Tony Flores — Million Dollar Mechanisms',                  filename: 'tony-flores-mechanisms.md',      tier: 1, approxTokens: 2000 },
  { id: 'evaldo-16-word',            title: 'Evaldo Albuquerque — The 16-Word Sales Letter',            filename: 'evaldo-16-word.md',              tier: 1, approxTokens: 3500 },
  { id: 'anghelache-crash-course',   title: 'John L. Anghelache — Copywriting Crash Course (distilled)', filename: 'anghelache-crash-course.md',     tier: 1, approxTokens: 3000 },
  { id: 'savage-system',             title: 'Peter Kell — Savage Advertising System',                   filename: 'savage-system.md',               tier: 1, approxTokens: 2000 },
  { id: '108-split-tests',           title: 'Russell Brunson — 108 Proven Split Test Winners',          filename: '108-split-tests.md',             tier: 1, approxTokens: 800 },
  // ── Tier 2 — per-task add-ons ──
  { id: 'landing-page-copyrecipes',  title: 'Landing-Page Copy Recipes by HTML tag',                    filename: 'landing-page-copyrecipes.md',    tier: 2, tasks: ['pdp','advertorial','upsell'], approxTokens: 3500,  priority: 100 },
  { id: 'cc-27-headlines',           title: 'Copy Coders — 27 AI Copy Codes: Headlines',                filename: 'cc-27-headlines.md',             tier: 2, tasks: ['headline','pdp','advertorial','vsl','ad'], approxTokens: 1600, priority: 95 },
  { id: 'sg-l63-big-ideas',          title: 'Stefan Georgi — Breakthrough BIG Ideas (5-step process)',  filename: 'sg-l63-big-ideas.md',            tier: 2, tasks: ['vsl','pdp','advertorial','headline','mechanism'], approxTokens: 5800, priority: 90 },
  { id: 'sg-l62-income-psychographics', title: 'Stefan Georgi — Income Opportunity Market Psychographics', filename: 'sg-l62-income-psychographics.md', tier: 2, tasks: ['vsl','pdp','advertorial','ad'], approxTokens: 7500, priority: 80 },
  { id: 'vsl-masterclass-community', title: 'VSL Masterclass — Community insights',                     filename: 'vsl-masterclass-community.md',   tier: 2, tasks: ['vsl','advertorial','headline'], approxTokens: 11000, priority: 60 },
  { id: 'ad-creatives-academy-posts',title: 'Ad Creatives Academy — Community posts (99ads)',           filename: 'ad-creatives-academy-posts.md',  tier: 2, tasks: ['ad'], approxTokens: 5800, priority: 70 },
  { id: 'ad-creatives-academy-top',  title: 'Ad Creatives Academy — Top posts (99ads)',                 filename: 'ad-creatives-academy-top.md',    tier: 2, tasks: ['ad'], approxTokens: 1000, priority: 75 },
  { id: 'advanced-ai-hooks-transcript', title: 'Advanced AI Hooks — Workshop call transcript',           filename: 'advanced-ai-hooks-transcript.md', tier: 2, tasks: ['headline','ad','vsl'], approxTokens: 27000, priority: 30 },
];

const cache = new Map();
function loadSource(src) {
  if (cache.has(src.id)) return cache.get(src.id);
  try {
    const content = fs.readFileSync(path.join(KB_DIR, src.filename), 'utf-8').trim();
    cache.set(src.id, content);
    return content;
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      cache.set(src.id, '');
      return null;
    }
    throw e;
  }
}
function frameSection(src, body) {
  return `<knowledge_source id="${src.id}" title="${src.title}">\n${body}\n</knowledge_source>`;
}

function getCoreKnowledge() {
  const blocks = [
    '# COPYWRITING KNOWLEDGE BASE — TIER 1 (CORE)',
    '',
    'You have direct access to the following direct-response copywriting frameworks.',
    'Use them as FOUNDATION of every copywriting decision.',
    '',
    '---',
    '',
  ];
  for (const src of SOURCES.filter((s) => s.tier === 1)) {
    const body = loadSource(src);
    if (!body) continue;
    blocks.push(frameSection(src, body));
    blocks.push('');
  }
  return blocks.join('\n');
}

function getKnowledgeForTask(task) {
  const matched = SOURCES.filter((s) => s.tier === 2 && (s.tasks?.includes(task) ?? false));
  if (matched.length === 0) return '';
  const sorted = [...matched].sort((a, b) => {
    const pa = a.priority ?? 50;
    const pb = b.priority ?? 50;
    if (pa !== pb) return pb - pa;
    return a.approxTokens - b.approxTokens;
  });
  const blocks = [];
  const included = [];
  let budget = MAX_TIER2_TOKENS;
  for (const src of sorted) {
    if (src.approxTokens > budget) continue;
    const body = loadSource(src);
    if (!body) continue;
    blocks.push(frameSection(src, body));
    blocks.push('');
    included.push(src);
    budget -= src.approxTokens;
  }
  if (included.length === 0) return '';
  const header = [
    `# COPYWRITING KNOWLEDGE BASE — TIER 2 (TASK: ${task.toUpperCase()})`,
    '',
    `Sources loaded (${included.length}): ${included.map((s) => s.id).join(', ')}.`,
    '',
    '---',
    '',
  ].join('\n');
  return header + '\n' + blocks.join('\n');
}

module.exports = { getCoreKnowledge, getKnowledgeForTask };
