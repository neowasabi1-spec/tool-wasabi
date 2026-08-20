// Step implementations for the Project Autopilot pipeline.
//
// Each step is a pure-ish async function: it reads what it needs from the
// project (Supabase), performs ONE focused LLM call with the relevant
// knowledge injected, writes the result back into the project, and returns a
// short summary + a text output for the job log. Steps never rely on an LLM
// "remembering" — they always re-read prior outputs from the DB.

import type { SupabaseClient } from '@supabase/supabase-js';
import { callClaudeWithKnowledge } from '@/lib/anthropic-with-knowledge';
import { buildSectionBlob, parseSectionData, type SectionFile } from '@/lib/project-sections';
import type { PipelineInput, StepKey } from './types';

export interface StepContext {
  supabase: SupabaseClient;
  projectId: string;
  input: PipelineInput;
}

export interface StepOutput {
  summary: string;
  output: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Market/language directive injected into every step so the whole pipeline
 * adapts to the target market. Priority:
 *   1. explicit `market` / `language` field (from the launcher), else
 *   2. inferred from the free-text description (e.g. "per il mercato tedesco"
 *      → tedesco + Germania), else
 *   3. Italian / Italy as the default.
 * The research + competitor references are tied to that geography, not just
 * the output language.
 */
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

/** Read the current project row (only the columns the steps care about). */
async function loadProject(ctx: StepContext) {
  const { data, error } = await ctx.supabase
    .from('projects')
    .select('id, name, description, domain, market_research, brief, front_end, funnel')
    .eq('id', ctx.projectId)
    .single();
  if (error || !data) {
    throw new Error(`Cannot load project ${ctx.projectId}: ${error?.message || 'not found'}`);
  }
  return data as Record<string, unknown>;
}

/** Wrap AI text into the canonical SectionData blob (one synthetic file). */
function toSectionBlob(fileName: string, content: string) {
  const file: SectionFile = {
    name: fileName,
    content,
    size: content.length,
    type: 'ai/markdown',
    uploadedAt: new Date().toISOString(),
  };
  return buildSectionBlob([file], '');
}

/** Best-effort readable brand name from a URL. */
function brandNameFromUrl(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const host = u.hostname.replace(/^www\./, '');
    const base = host.split('.')[0] || host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return 'Competitor';
  }
}

function isMetaAdLibrary(url: string): boolean {
  return /facebook\.com\/ads\/library/i.test(url);
}

/** Extract plain text from the project's market research section. */
function researchText(project: Record<string, unknown>): string {
  return parseSectionData(project.market_research).content || '';
}

function briefText(project: Record<string, unknown>): string {
  const raw = project.brief;
  if (typeof raw === 'string' && raw.trim()) return raw;
  return parseSectionData(raw).content || '';
}

/** Persist to a JSONB section column, tolerating older schemas. */
async function saveSection(
  ctx: StepContext,
  column: 'market_research' | 'funnel' | 'front_end',
  fileName: string,
  content: string,
) {
  const blob = toSectionBlob(fileName, content);
  const { error } = await ctx.supabase
    .from('projects')
    .update({ [column]: blob })
    .eq('id', ctx.projectId);
  if (error) throw new Error(`Failed to save ${column}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// STEP 1 — Market research
// ---------------------------------------------------------------------------

async function runMarketResearch(ctx: StepContext): Promise<StepOutput> {
  const project = await loadProject(ctx);
  const productName = (project.name as string) || ctx.input.product;

  const instructions = `Sei un ricercatore di mercato senior specializzato in direct response e ecommerce.
Produci una RICERCA DI MERCATO completa e operativa, pronta per essere usata da un copywriter.
${marketDirective(ctx.input)}
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
${ctx.input.description ? `\nDescrizione fornita:\n${ctx.input.description}` : ''}
${ctx.input.competitorLink ? `\nLink competitor di riferimento: ${ctx.input.competitorLink}` : ''}

Genera la ricerca di mercato completa per questo prodotto.`;

  const { reply } = await callClaudeWithKnowledge({
    task: 'general',
    instructions,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 4096,
  });

  const content = reply.trim();
  if (!content) throw new Error('Market research returned empty output');

  await saveSection(ctx, 'market_research', 'AI — Ricerca di mercato', content);

  return {
    summary: 'Ricerca di mercato generata e salvata nella sezione Market Research.',
    output: content,
  };
}

// ---------------------------------------------------------------------------
// STEP 2 — Brief
// ---------------------------------------------------------------------------

async function runBrief(ctx: StepContext): Promise<StepOutput> {
  const project = await loadProject(ctx);
  const productName = (project.name as string) || ctx.input.product;
  const research = researchText(project);

  const instructions = `Sei un copywriter direct response e stratega ecommerce di alto livello.
Data la ricerca di mercato e le info prodotto, genera un PRODUCT RESEARCH BRIEF completo seguendo il framework "Ecom Domination".
${marketDirective(ctx.input)}
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
${ctx.input.description ? `\nDescrizione fornita:\n${ctx.input.description}` : ''}

Genera il brief completo. Basati fortemente sulla RICERCA DI MERCATO fornita nel contesto.`;

  const { reply } = await callClaudeWithKnowledge({
    task: 'general',
    instructions,
    marketResearch: research,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 4096,
  });

  const content = reply.trim();
  if (!content) throw new Error('Brief returned empty output');

  // brief is a TEXT column; mirror the file list into brief_files when present.
  const { error: briefErr } = await ctx.supabase
    .from('projects')
    .update({ brief: content })
    .eq('id', ctx.projectId);
  if (briefErr) throw new Error(`Failed to save brief: ${briefErr.message}`);

  try {
    await ctx.supabase
      .from('projects')
      .update({ brief_files: toSectionBlob('AI — Brief prodotto', content) })
      .eq('id', ctx.projectId);
  } catch { /* brief_files column may not exist on older schemas */ }

  return {
    summary: 'Brief prodotto generato e salvato nella sezione Brief.',
    output: content,
  };
}

// ---------------------------------------------------------------------------
// STEP 3 — Competitor
// ---------------------------------------------------------------------------

async function runCompetitor(ctx: StepContext): Promise<StepOutput> {
  const link = (ctx.input.competitorLink || '').trim();
  if (!link) {
    return {
      summary: 'Nessun link competitor fornito — step saltato.',
      output: 'Nessun competitor da analizzare (nessun link in input).',
    };
  }

  const project = await loadProject(ctx);
  const research = researchText(project);
  const brief = briefText(project);

  const instructions = `Sei un analista competitor per funnel direct response.
Analizza il competitor indicato (dal link e dal contesto di brief/ricerca) e produci una SCHEDA COMPETITOR sintetica e operativa.
${marketDirective(ctx.input)}
Includi: posizionamento, angolo principale, meccanismo comunicato, punti di forza, debolezze sfruttabili, e 3 idee per superarlo.
Sii concreto. Se non puoi vedere la pagina, ragiona sulle info disponibili senza inventare dati falsi.`;

  const userMessage = `Link competitor: ${link}
Prodotto: ${(project.name as string) || ctx.input.product}

Analizza questo competitor e produci la scheda.`;

  const { reply } = await callClaudeWithKnowledge({
    task: 'general',
    instructions,
    brief,
    marketResearch: research,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 2048,
  });

  const analysis = reply.trim();
  const brandName = brandNameFromUrl(link);

  // Persist a competitor brand row so it shows up in the Competitor Library.
  const row: Record<string, unknown> = {
    project_id: ctx.projectId,
    name: brandName,
    ads_library_url: isMetaAdLibrary(link) ? link : '',
    brand_type: 'competitor',
    notes: link,
    creative_quality_notes: analysis.slice(0, 4000),
  };
  const { error } = await ctx.supabase.from('competitor_brands').insert(row);
  if (error) {
    // Non-fatal: still return the analysis so nothing is lost.
    return {
      summary: `Analisi competitor generata (salvataggio brand fallito: ${error.message}).`,
      output: analysis,
    };
  }

  return {
    summary: `Competitor "${brandName}" salvato nella Competitor Library con analisi.`,
    output: analysis,
  };
}

// ---------------------------------------------------------------------------
// STEP 4 — Angle strategy (prioritized Angle Matrix)
// ---------------------------------------------------------------------------

async function runAngle(ctx: StepContext): Promise<StepOutput> {
  const project = await loadProject(ctx);
  const productName = (project.name as string) || ctx.input.product;
  const research = researchText(project);
  const brief = briefText(project);

  const instructions = `Sei uno stratega direct response. Costruisci una ANGLE MATRIX prioritizzata (6-8 angoli, best-first) per questo prodotto, basata su ricerca e brief.
${marketDirective(ctx.input)}
Per OGNI angolo usa questo formato markdown:
## ANGLE 1 — <nome angolo>
- **Awareness:** <1-5 + perché>
- **Sophistication:** <new claim | mechanism | amplified claim | identification>
- **Core emotion:** <emozione dominante>
- **Big idea:** <una frase>
- **Meccanismo unico:** <nome>
- **Prova richiesta:** <...>
- **Gap competitor:** <cosa non dicono i competitor>
- **Hook:** "<apertura scroll-stopping>"
Gli angoli devono essere davvero diversi tra loro. Niente filler generico.`;

  const userMessage = `Prodotto: ${productName}
${ctx.input.description ? `\nDescrizione:\n${ctx.input.description}` : ''}

Costruisci la Angle Matrix, angolo migliore per primo.`;

  const { reply } = await callClaudeWithKnowledge({
    task: 'general',
    instructions,
    brief,
    marketResearch: research,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 4096,
  });

  const content = reply.trim();
  if (!content) throw new Error('Angle step returned empty output');

  await saveSection(ctx, 'front_end', 'AI — Angle Matrix', content);

  return {
    summary: 'Angle Matrix generata e salvata.',
    output: content,
  };
}

// ---------------------------------------------------------------------------
// STEP 5 — Ads / angles
// ---------------------------------------------------------------------------

async function runAds(ctx: StepContext): Promise<StepOutput> {
  const project = await loadProject(ctx);
  const brief = briefText(project);
  const research = researchText(project);

  const instructions = `Sei un direct response copywriter esperto in creativi ad alta conversione.
Genera 5 CONCEPT PUBBLICITARI distinti per questo prodotto.
${marketDirective(ctx.input)}
Per OGNI concept usa ESATTAMENTE questo formato, separando i concept con una riga "---":

ANGOLO: <nome sintetico dell'angolo>
HOOK: <prima riga / scroll-stopper>
HEADLINE: <headline principale>
BODY: <2-4 frasi di corpo persuasivo>
CTA: <call to action>

Gli angoli devono essere davvero diversi tra loro (meccanismo, paura, desiderio, identità, prova sociale...). Nessun testo extra fuori dal formato.`;

  const userMessage = `Prodotto: ${(project.name as string) || ctx.input.product}
Genera i 5 concept basandoti su brief e ricerca di mercato forniti nel contesto.`;

  const { reply } = await callClaudeWithKnowledge({
    task: 'general',
    instructions,
    brief,
    marketResearch: research,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 3000,
  });

  const raw = reply.trim();
  const concepts = parseAdConcepts(raw);

  let saved = 0;
  if (concepts.length > 0) {
    const rows = concepts.map((c) => ({
      project_id: ctx.projectId,
      type: 'concept',
      angle: c.angle.slice(0, 300),
      concept_notes: c.body,
      output_status: 'ready',
    }));
    const { error } = await ctx.supabase.from('creative_outputs').insert(rows);
    if (!error) saved = rows.length;
  }

  return {
    summary:
      saved > 0
        ? `${saved} concept pubblicitari generati e salvati (Creative).`
        : `${concepts.length || 5} concept generati (salvataggio non riuscito, output nel log).`,
    output: raw,
  };
}

interface AdConcept {
  angle: string;
  hook: string;
  headline: string;
  body: string;
  cta: string;
}

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
      hook: get('HOOK'),
      headline: get('HEADLINE'),
      body: [get('HOOK'), get('HEADLINE'), get('BODY'), get('CTA') ? `CTA: ${get('CTA')}` : '']
        .filter(Boolean)
        .join('\n'),
      cta: get('CTA'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// STEP 5 — Landing copy
// ---------------------------------------------------------------------------

async function runLanding(ctx: StepContext): Promise<StepOutput> {
  const project = await loadProject(ctx);
  const brief = briefText(project);
  const research = researchText(project);

  const instructions = `Sei un copywriter di landing page direct response.
Scrivi la STRUTTURA + COPY completo di una landing page ad alta conversione per questo prodotto.
${marketDirective(ctx.input)}
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

  const userMessage = `Prodotto: ${(project.name as string) || ctx.input.product}
Scrivi la landing completa basandoti su brief e ricerca di mercato forniti nel contesto.`;

  const { reply } = await callClaudeWithKnowledge({
    task: 'general',
    instructions,
    brief,
    marketResearch: research,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 4096,
  });

  const content = reply.trim();
  if (!content) throw new Error('Landing returned empty output');

  await saveSection(ctx, 'funnel', 'AI — Landing copy', content);

  return {
    summary: 'Copy della landing page generato e salvato nella sezione Funnel.',
    output: content,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const RUNNERS: Record<StepKey, (ctx: StepContext) => Promise<StepOutput>> = {
  market_research: runMarketResearch,
  brief: runBrief,
  competitor: runCompetitor,
  angle: runAngle,
  ads: runAds,
  landing: runLanding,
};

export async function runStep(key: StepKey, ctx: StepContext): Promise<StepOutput> {
  const runner = RUNNERS[key];
  if (!runner) throw new Error(`Unknown pipeline step: ${key}`);
  return runner(ctx);
}
