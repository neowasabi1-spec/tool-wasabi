import { createClient } from '@supabase/supabase-js';
import { getCoreKnowledge, getKnowledgeForTask } from '../../src/knowledge/copywriting';

/**
 * Background function (up to 15 min) that RUNS the Project Autopilot pipeline
 * end-to-end. It performs the AI calls + Supabase writes ITSELF.
 *
 * Why not call the Next.js `/api/pipeline/step` route like before? Because
 * Netlify kills internal function-to-function HTTP calls at ~26s ("terminated"
 * / 504 Inactivity), which left every step stuck as "running". A background
 * function has a 15-minute budget and no such cap, so we do the work here and
 * the only network calls are to Anthropic + Supabase (both external).
 *
 * Body: { jobId }
 */

const STEP_ORDER = ['market_research', 'brief', 'competitor', 'ads', 'landing'] as const;
type StepKey = (typeof STEP_ORDER)[number];

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-opus-4-8';
const STEP_OUTPUT_PREVIEW_CHARS = 4000;

interface PipelineInput {
  product?: string;
  competitorLink?: string;
  description?: string;
  market?: string;
  language?: string;
}

interface StepState {
  key: string;
  label?: string;
  status?: string;
  summary?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  [k: string]: unknown;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) throw new Error('Supabase env (URL / SERVICE_ROLE_KEY) missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
type SupabaseClient = ReturnType<typeof getSupabase>;

// ---------------------------------------------------------------------------
// Section blob helpers (mirror src/lib/project-sections.ts so the UI reads it)
// ---------------------------------------------------------------------------

interface SectionFile { name: string; content: string; size: number; type: string; uploadedAt: string; }

function buildSectionContent(files: SectionFile[], notes: string): string {
  const parts: string[] = [];
  for (const f of files) {
    if (!f?.content?.trim()) continue;
    parts.push(`=== FILE: ${f.name} ===\n\n${f.content.trim()}`);
  }
  if (notes?.trim()) parts.push(`\n\n=== NOTES ===\n\n${notes.trim()}`);
  return parts.join('\n').trim();
}

function toSectionBlob(fileName: string, content: string) {
  const file: SectionFile = {
    name: fileName,
    content,
    size: content.length,
    type: 'ai/markdown',
    uploadedAt: new Date().toISOString(),
  };
  return { files: [file], notes: '', content: buildSectionContent([file], '') };
}

function sectionContentFrom(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') {
    const t = val.trim();
    if (t.startsWith('{')) {
      try {
        const p = JSON.parse(t);
        if (p && typeof p === 'object' && typeof p.content === 'string') return p.content;
      } catch { /* plain string */ }
    }
    return val;
  }
  if (typeof val === 'object') {
    const o = val as Record<string, unknown>;
    if (typeof o.content === 'string' && o.content) return o.content;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Anthropic call with Knowledge Base injection + prompt caching
// ---------------------------------------------------------------------------

interface ClaudeOpts {
  instructions: string;
  brief?: string;
  marketResearch?: string;
  userMessage: string;
  maxTokens: number;
}

async function callClaude(opts: ClaudeOpts): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  // System blocks: instructions + Tier1 KB (cached), Tier2 KB (cached).
  const system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [];
  let core = '';
  let tier2 = '';
  try { core = getCoreKnowledge().trim(); } catch { core = ''; }
  try { tier2 = getKnowledgeForTask('general').trim(); } catch { tier2 = ''; }

  const tier1 = [opts.instructions.trim(), core].filter(Boolean).join('\n\n---\n\n');
  system.push({ type: 'text', text: tier1, cache_control: { type: 'ephemeral' } });
  if (tier2) system.push({ type: 'text', text: tier2, cache_control: { type: 'ephemeral' } });

  // User message with brief + research prefixed.
  const sections: string[] = [];
  if (opts.brief?.trim()) sections.push('# PRODUCT BRIEF', '', opts.brief.trim());
  if (opts.marketResearch?.trim()) sections.push('# MARKET RESEARCH', '', opts.marketResearch.trim());
  sections.push('# REQUEST', '', opts.userMessage);
  const userContent = sections.join('\n\n');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error: ${res.status} ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  return (data.content?.[0]?.text ?? '').trim();
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function marketDirective(input: PipelineInput): string {
  const explicit = (input.market || input.language || '').trim();
  if (explicit) {
    return `MERCATO TARGET: ${explicit}.
- Scrivi TUTTO l'output nella lingua di questo mercato (es. mercato tedesco/Germania → in tedesco).
- Fai ricerca, esempi, concorrenti, abitudini d'acquisto, prezzi e riferimenti normativi relativi a QUESTA geografia.`;
  }
  return `MERCATO TARGET: deducilo dalla DESCRIZIONE del prodotto (es. "per il mercato tedesco" → lingua tedesca + Germania).
- Scrivi TUTTO l'output nella lingua del mercato target dedotto.
- Fai ricerca ed esempi riferiti alla geografia di quel mercato.
- Se nella descrizione non è indicato alcun mercato/lingua, usa l'italiano e il mercato Italia.`;
}

function brandNameFromUrl(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const host = u.hostname.replace(/^www\./, '');
    const base = host.split('.')[0] || host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch { return 'Competitor'; }
}
function isMetaAdLibrary(url: string): boolean { return /facebook\.com\/ads\/library/i.test(url); }

interface AdConcept { angle: string; body: string; }
function parseAdConcepts(raw: string): AdConcept[] {
  const blocks = raw.split(/\n-{2,}\n|\n---\n/g).map((b) => b.trim()).filter(Boolean);
  const out: AdConcept[] = [];
  for (const b of blocks) {
    const get = (label: string) => {
      const m = b.match(new RegExp(`${label}\\s*:\\s*(.+)`, 'i'));
      return m ? m[1].trim() : '';
    };
    const angle = get('ANGOLO') || get('ANGLE');
    if (!angle && !get('HEADLINE')) continue;
    out.push({
      angle: angle || 'Concept',
      body: [get('HOOK'), get('HEADLINE'), get('BODY'), get('CTA') ? `CTA: ${get('CTA')}` : '']
        .filter(Boolean).join('\n'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Steps — each returns { summary, output }
// ---------------------------------------------------------------------------

interface StepResult { summary: string; output: string; }

async function loadProject(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, description, domain, market_research, brief, front_end, funnel')
    .eq('id', projectId)
    .single();
  if (error || !data) throw new Error(`Cannot load project ${projectId}: ${error?.message || 'not found'}`);
  return data as Record<string, unknown>;
}

async function runMarketResearch(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const productName = (project.name as string) || input.product || '';

  const instructions = `Sei un ricercatore di mercato senior specializzato in direct response e ecommerce.
Produci una RICERCA DI MERCATO completa e operativa, pronta per essere usata da un copywriter.
${marketDirective(input)}
Usa markdown con intestazioni chiare.

La ricerca DEVE contenere queste sezioni:
## Avatar / Cliente ideale
Demografia, psicografia, giornata tipo, identità.
## Dolori e frustrazioni
Elenca i dolori profondi (non superficiali), con linguaggio "voice of customer".
## Desideri e sogni
Cosa vogliono davvero ottenere (risultato + trasformazione identitaria).
## Consapevolezza e sofisticazione (Schwartz)
Stima lo stadio di consapevolezza (1-5) e il livello di sofisticazione del mercato, con motivazione.
## Obiezioni e credenze da spostare
Le obiezioni principali e la "core buying belief" da costruire.
## Meccanismo del problema e della soluzione
Il meccanismo unico che tiene vivo il problema e come il prodotto lo risolve.
## Angoli di mercato
5-7 angoli distinti sfruttabili nelle ads e nella landing.
Sii specifico, concreto e non generico.`;

  const userMessage = `Prodotto: ${productName}
${input.description ? `\nDescrizione fornita:\n${input.description}` : ''}
${input.competitorLink ? `\nLink competitor di riferimento: ${input.competitorLink}` : ''}

Genera la ricerca di mercato completa per questo prodotto.`;

  const content = await callClaude({ instructions, userMessage, maxTokens: 4096 });
  if (!content) throw new Error('Market research returned empty output');

  const { error } = await supabase
    .from('projects')
    .update({ market_research: toSectionBlob('AI — Ricerca di mercato', content) })
    .eq('id', projectId);
  if (error) throw new Error(`Failed to save market_research: ${error.message}`);

  return { summary: 'Ricerca di mercato generata e salvata nella sezione Market Research.', output: content };
}

async function runBrief(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const productName = (project.name as string) || input.product || '';
  const research = sectionContentFrom(project.market_research);

  const instructions = `Sei un copywriter direct response e stratega ecommerce di alto livello.
Data la ricerca di mercato e le info prodotto, genera un PRODUCT RESEARCH BRIEF completo seguendo il framework "Ecom Domination".
${marketDirective(input)}
Usa markdown con intestazioni in grassetto.

Struttura richiesta:
**TARGET MARKET** — chi è il buyer ideale (demografia, psicografia, pain, lifestyle)
**PRODOTTO (Nome, Cosa fa, Meccanismo di delivery)**
**MECCANISMO UNICO DEL PROBLEMA**
**MECCANISMO UNICO DELLA SOLUZIONE**
**CARATTERIZZAZIONI (Soprannomi)** — per problemi e per soluzioni
**HOOK (3-5 aperture ad alto impatto)**
**PROVA TESTABILE**
**METAFORE POTENTI**
**DOMANDE PARADOSSALI**
**FASCINATIONS (bullet di curiosità)**
**NARRATIVA DEL PROBLEMA** (early signs → peggioramento → crisi → punto emotivo più basso)
**MITI & ERRORI**
**UNIQUE MECHANISM PREVIEW (UMP)** (discovery, trigger, spiegazione, prova)
**SPIEGAZIONE SOLUZIONE** (3 principi)
**PROVA & VERIFICA**
**ANGOLI ADS SUGGERITI** (3-5)`;

  const userMessage = `Prodotto: ${productName}
${input.description ? `\nDescrizione fornita:\n${input.description}` : ''}

Genera il brief completo. Basati fortemente sulla RICERCA DI MERCATO fornita nel contesto.`;

  const content = await callClaude({ instructions, marketResearch: research, userMessage, maxTokens: 4096 });
  if (!content) throw new Error('Brief returned empty output');

  const { error } = await supabase.from('projects').update({ brief: content }).eq('id', projectId);
  if (error) throw new Error(`Failed to save brief: ${error.message}`);
  try {
    await supabase.from('projects').update({ brief_files: toSectionBlob('AI — Brief prodotto', content) }).eq('id', projectId);
  } catch { /* brief_files column may not exist */ }

  return { summary: 'Brief prodotto generato e salvato nella sezione Brief.', output: content };
}

async function runCompetitor(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const link = (input.competitorLink || '').trim();
  if (!link) {
    return { summary: 'Nessun link competitor fornito — step saltato.', output: 'Nessun competitor da analizzare.' };
  }
  const project = await loadProject(supabase, projectId);
  const research = sectionContentFrom(project.market_research);
  const brief = typeof project.brief === 'string' && project.brief.trim() ? (project.brief as string) : sectionContentFrom(project.brief);

  const instructions = `Sei un analista competitor per funnel direct response.
Analizza il competitor indicato (dal link e dal contesto di brief/ricerca) e produci una SCHEDA COMPETITOR sintetica e operativa.
${marketDirective(input)}
Includi: posizionamento, angolo principale, meccanismo comunicato, punti di forza, debolezze sfruttabili, e 3 idee per superarlo.
Sii concreto. Se non puoi vedere la pagina, ragiona sulle info disponibili senza inventare dati falsi.`;

  const userMessage = `Link competitor: ${link}
Prodotto: ${(project.name as string) || input.product || ''}

Analizza questo competitor e produci la scheda.`;

  const analysis = await callClaude({ instructions, brief, marketResearch: research, userMessage, maxTokens: 2048 });
  const brandName = brandNameFromUrl(link);

  const row: Record<string, unknown> = {
    project_id: projectId,
    name: brandName,
    ads_library_url: isMetaAdLibrary(link) ? link : '',
    brand_type: 'competitor',
    notes: link,
    creative_quality_notes: analysis.slice(0, 4000),
  };
  const { error } = await supabase.from('competitor_brands').insert(row);
  if (error) {
    return { summary: `Analisi competitor generata (salvataggio brand fallito: ${error.message}).`, output: analysis };
  }
  return { summary: `Competitor "${brandName}" salvato nella Competitor Library con analisi.`, output: analysis };
}

async function runAds(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const research = sectionContentFrom(project.market_research);
  const brief = typeof project.brief === 'string' && project.brief.trim() ? (project.brief as string) : sectionContentFrom(project.brief);

  const instructions = `Sei un direct response copywriter esperto in creativi ad alta conversione.
Genera 5 CONCEPT PUBBLICITARI distinti per questo prodotto.
${marketDirective(input)}
Per OGNI concept usa ESATTAMENTE questo formato, separando i concept con una riga "---":

ANGOLO: <nome sintetico dell'angolo>
HOOK: <prima riga / scroll-stopper>
HEADLINE: <headline principale>
BODY: <2-4 frasi di corpo persuasivo>
CTA: <call to action>

Gli angoli devono essere davvero diversi tra loro (meccanismo, paura, desiderio, identità, prova sociale...). Nessun testo extra fuori dal formato.`;

  const userMessage = `Prodotto: ${(project.name as string) || input.product || ''}
Genera i 5 concept basandoti su brief e ricerca di mercato forniti nel contesto.`;

  const raw = await callClaude({ instructions, brief, marketResearch: research, userMessage, maxTokens: 3000 });
  const concepts = parseAdConcepts(raw);

  let saved = 0;
  if (concepts.length > 0) {
    const rows = concepts.map((c) => ({
      project_id: projectId,
      type: 'concept',
      angle: c.angle.slice(0, 300),
      concept_notes: c.body,
      output_status: 'ready',
    }));
    const { error } = await supabase.from('creative_outputs').insert(rows);
    if (!error) saved = rows.length;
  }
  return {
    summary: saved > 0
      ? `${saved} concept pubblicitari generati e salvati (Creative).`
      : `${concepts.length || 5} concept generati (salvataggio non riuscito, output nel log).`,
    output: raw,
  };
}

async function runLanding(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const research = sectionContentFrom(project.market_research);
  const brief = typeof project.brief === 'string' && project.brief.trim() ? (project.brief as string) : sectionContentFrom(project.brief);

  const instructions = `Sei un copywriter di landing page direct response.
Scrivi la STRUTTURA + COPY completo di una landing page ad alta conversione per questo prodotto.
${marketDirective(input)}
Usa markdown con una sezione per blocco:
## Hero (headline + subheadline + CTA)
## Problema / Agitazione
## Meccanismo unico (perché fallisce il resto)
## Soluzione / Prodotto
## Come funziona (step)
## Prove & testimonianze (struttura)
## Offerta & garanzia
## FAQ
## CTA finale
Il copy deve essere pronto all'uso, coerente con brief e ricerca. Sii specifico, niente placeholder generici.`;

  const userMessage = `Prodotto: ${(project.name as string) || input.product || ''}
Scrivi la landing completa basandoti su brief e ricerca di mercato forniti nel contesto.`;

  const content = await callClaude({ instructions, brief, marketResearch: research, userMessage, maxTokens: 4096 });
  if (!content) throw new Error('Landing returned empty output');

  const { error } = await supabase
    .from('projects')
    .update({ funnel: toSectionBlob('AI — Landing copy', content) })
    .eq('id', projectId);
  if (error) throw new Error(`Failed to save funnel: ${error.message}`);

  return { summary: 'Copy della landing page generato e salvato nella sezione Funnel.', output: content };
}

const RUNNERS: Record<StepKey, (s: SupabaseClient, p: string, i: PipelineInput) => Promise<StepResult>> = {
  market_research: runMarketResearch,
  brief: runBrief,
  competitor: runCompetitor,
  ads: runAds,
  landing: runLanding,
};

// ---------------------------------------------------------------------------
// Main sequencer
// ---------------------------------------------------------------------------

export default async (req: Request) => {
  let jobId = '';
  try { jobId = String((await req.json())?.jobId || ''); } catch { /* ignore */ }
  if (!jobId) return new Response('missing jobId', { status: 200 });

  const supabase = getSupabase();
  const log = (...a: unknown[]) => console.log(`[pipeline ${jobId}]`, ...a);

  const { data: job, error } = await supabase
    .from('pipeline_jobs')
    .select('id, project_id, input, status, steps')
    .eq('id', jobId)
    .single();
  if (error || !job) { log('job not found:', error?.message); return new Response('job not found', { status: 200 }); }
  if (!job.project_id) { log('job has no project_id'); return new Response('no project', { status: 200 }); }

  const projectId = job.project_id as string;
  const input = (job.input || {}) as PipelineInput;
  const steps: StepState[] = Array.isArray(job.steps) ? (job.steps as StepState[]) : [];
  const orderedKeys: string[] = steps.length > 0 ? steps.map((s) => s.key) : [...STEP_ORDER];

  const persistSteps = async (patch: Record<string, unknown> = {}) => {
    await supabase.from('pipeline_jobs').update({ steps, ...patch }).eq('id', jobId);
  };

  for (const key of orderedKeys) {
    // Cancellation check.
    const { data: fresh } = await supabase.from('pipeline_jobs').select('status').eq('id', jobId).single();
    if (fresh?.status === 'canceled') { log('canceled — stopping'); return new Response('canceled', { status: 200 }); }

    const idx = steps.findIndex((s) => s.key === key);
    if (idx === -1) continue;
    const cur = steps[idx];
    if (cur.status === 'completed' || cur.status === 'skipped') continue;

    const runner = RUNNERS[key as StepKey];
    if (!runner) continue;

    log('running step', key);
    steps[idx] = { ...cur, status: 'running', startedAt: new Date().toISOString(), error: undefined };
    await persistSteps({ status: 'running', current_step: key, error: null });

    try {
      const result = await runner(supabase, projectId, input);
      steps[idx] = {
        ...steps[idx],
        status: 'completed',
        summary: result.summary,
        output: (result.output || '').slice(0, STEP_OUTPUT_PREVIEW_CHARS),
        finishedAt: new Date().toISOString(),
        error: undefined,
      };
      const allDone = steps.every((s) => s.status === 'completed' || s.status === 'skipped');
      await persistSteps({ status: allDone ? 'completed' : 'running', current_step: allDone ? null : key });
      log('step', key, '→ completed');
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 1000) || 'Errore step';
      steps[idx] = { ...steps[idx], status: 'failed', error: msg, finishedAt: new Date().toISOString() };
      await persistSteps({ status: 'failed', current_step: key, error: `Step ${key}: ${msg}`.slice(0, 1000) });
      log('step', key, '→ failed:', msg);
      return new Response('failed', { status: 200 });
    }
  }

  log('done');
  return new Response('done', { status: 200 });
};
