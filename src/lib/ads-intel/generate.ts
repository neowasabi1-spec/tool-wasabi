/**
 * Concept generation + native image asset creation.
 * Generator never receives raw source ad copy — only DNA/mechanism summaries.
 */

import { randomBytes } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUploadUrl } from '@/lib/projecthub-storage';
import { openaiGenerateImageBytes } from '@/lib/openai-image';
import { normalizeBrandRules, brandContext, brandRulesText } from './brain';
import { hasOpenRouter, openrouterChat, parseJsonLoose, writerModel } from './openrouter';

function wasCode(): string {
  return `WAS-${randomBytes(4).toString('hex')}`;
}

async function loadBrand(projectId: string) {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('name, brand_rules')
    .eq('id', projectId)
    .single();
  if (error) throw new Error(error.message);
  return {
    name: String(data.name || 'Brand'),
    rules: normalizeBrandRules(data.brand_rules),
  };
}

/** Build DNA from analyses only (no raw ad body passed to generator). */
function dnaFromAnalyses(rows: Record<string, unknown>[]) {
  return rows.map((r) => {
    const ex = (r.extraction || {}) as Record<string, unknown>;
    const llm = (ex.llm || {}) as Record<string, unknown>;
    return {
      analysis_id: r.id,
      mechanism: String(llm.mechanism || ex.mechanism_guess || '').slice(0, 500),
      hook_type: String(llm.hook_type || ''),
      offer_signals: llm.offer_signals ?? [],
      visual_notes: String(llm.visual_notes || ''),
    };
  });
}

export async function generateConcepts(opts: {
  projectId: string;
  analysisIds?: number[];
  count?: number;
}): Promise<{ concepts: Record<string, unknown>[] }> {
  const brand = await loadBrand(opts.projectId);
  const count = Math.min(Math.max(opts.count || 3, 1), 8);

  let q = supabaseAdmin
    .from('creative_analyses')
    .select('*')
    .eq('project_id', opts.projectId)
    .eq('status', 'ready')
    .order('updated_at', { ascending: false })
    .limit(10);

  if (opts.analysisIds?.length) {
    q = supabaseAdmin
      .from('creative_analyses')
      .select('*')
      .eq('project_id', opts.projectId)
      .in('id', opts.analysisIds);
  }

  const { data: analyses, error } = await q;
  if (error) throw new Error(error.message);
  if (!analyses?.length) {
    throw new Error('No ready analyses — run Analyze on ads first');
  }

  const dna = dnaFromAnalyses(analyses as Record<string, unknown>[]);
  const analysisIds = dna.map((d) => Number(d.analysis_id));

  let conceptsPayload: { title: string; brief: string; kind: string }[] = [];

  if (hasOpenRouter()) {
    const system = [
      'You invent NEW Meta ad concepts for our brand.',
      'You receive ONLY persuasion DNA (mechanism/hook_type). Never copy source wording.',
      'Return JSON: { "concepts": [ { "title", "brief", "kind": "image"|"text" } ] }',
      brandContext(brand.name, brand.rules),
      brandRulesText(brand.rules),
    ].join('\n\n');
    const content = await openrouterChat({
      model: writerModel(),
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Create ${count} concepts from this DNA:\n${JSON.stringify(dna, null, 2)}`,
        },
      ],
      json: true,
      maxTokens: 3000,
      temperature: 0.8,
    });
    const parsed = parseJsonLoose(content) as { concepts?: any[] };
    conceptsPayload = (parsed.concepts || []).slice(0, count).map((c) => ({
      title: String(c.title || 'Untitled'),
      brief: String(c.brief || ''),
      kind: c.kind === 'text' ? 'text' : 'image',
    }));
  } else {
    // Offline / no OpenRouter: deterministic stubs from DNA
    conceptsPayload = dna.slice(0, count).map((d, i) => ({
      title: `Concept ${i + 1}: ${String(d.hook_type || 'mechanism').slice(0, 40) || 'angle'}`,
      brief: `New execution of mechanism without copying source.\nMechanism DNA: ${d.mechanism.slice(0, 280)}\nBrand tone: ${brand.rules.tone || 'n/a'}`,
      kind: 'image',
    }));
  }

  const saved: Record<string, unknown>[] = [];
  for (const c of conceptsPayload) {
    const { data, error: insErr } = await supabaseAdmin
      .from('creative_concepts')
      .insert({
        project_id: opts.projectId,
        kind: c.kind,
        title: c.title,
        brief: c.brief,
        dna: { items: dna },
        source_analysis_ids: analysisIds,
        status: 'draft',
      })
      .select('*')
      .single();
    if (insErr) throw new Error(insErr.message);
    saved.push(data as Record<string, unknown>);
  }

  return { concepts: saved };
}

export async function createOutputFromConcept(opts: {
  projectId: string;
  conceptId: number;
}): Promise<Record<string, unknown>> {
  const { data: concept, error } = await supabaseAdmin
    .from('creative_concepts')
    .select('*')
    .eq('id', opts.conceptId)
    .eq('project_id', opts.projectId)
    .single();
  if (error || !concept) throw new Error(error?.message || 'Concept not found');

  const brand = await loadBrand(opts.projectId);
  const code = wasCode();
  const skipAssets = ['1', 'true', 'yes'].includes(
    (process.env.ADS_INTEL_SKIP_ASSETS || '').trim().toLowerCase(),
  );

  const imagePrompt = [
    `Brand: ${brand.name}`,
    `Tone: ${brand.rules.tone || 'professional'}`,
    `Palette names: ${brand.rules.palette.join(', ') || 'brand colours'}`,
    brand.rules.logo_rules ? `Logo: ${brand.rules.logo_rules}` : '',
    `Concept: ${concept.title}`,
    concept.brief,
    'Square 1:1 Meta feed creative. No unreadable microtext. No competitor logos.',
  ]
    .filter(Boolean)
    .join('\n');

  const spec = {
    kind: concept.kind,
    language: 'en',
    image_prompt: imagePrompt,
    on_image_text: [],
  };

  let resultPath = '';
  let gate = 'review';

  if (concept.kind === 'image' && !skipAssets) {
    const bytes = await openaiGenerateImageBytes({
      prompt: imagePrompt,
      size: '1024x1024',
      timeoutMs: 120_000,
    });
    if (bytes) {
      const path = `${opts.projectId}/ads-intel/outputs/${code}.png`;
      const { error: upErr } = await supabaseAdmin.storage
        .from('project-files')
        .upload(path, bytes.buf, { contentType: bytes.mime, upsert: true });
      if (!upErr) {
        resultPath = path;
        gate = 'pass';
      }
    } else {
      gate = 'review';
    }
  } else if (skipAssets) {
    gate = 'review';
  }

  const { data: out, error: outErr } = await supabaseAdmin
    .from('creative_outputs')
    .insert({
      project_id: opts.projectId,
      type: 'concept',
      angle: concept.title,
      concept_notes: concept.brief,
      output_status: resultPath ? 'ready' : 'pending',
      feedback: '',
      code,
      concept_id: concept.id,
      kind: concept.kind,
      spec,
      result_path: resultPath,
      gate_decision: gate,
    })
    .select('*')
    .single();

  if (outErr) throw new Error(outErr.message);

  // Optional: also save to creative_templates when we have an asset
  if (resultPath) {
    await supabaseAdmin.from('creative_templates').insert({
      project_id: opts.projectId,
      name: `${code} — ${concept.title}`.slice(0, 120),
      source_brand: brand.name,
      category: 'Ads Creative',
      file_path: resultPath,
      media_type: 'image',
      tags: code,
    });
  }

  return {
    ...(out as object),
    preview_url: resultPath ? getUploadUrl(resultPath) : '',
  } as Record<string, unknown>;
}
