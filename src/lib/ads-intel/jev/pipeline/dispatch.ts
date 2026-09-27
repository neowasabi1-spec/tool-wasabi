import { analyzeCreative, analyzeProduct } from './analyze';
import { reassignProduct } from './assign';
import { buildImageFeatures } from './families';
import { familyGenerate, hookVariants, type FamilyGenOpts } from './familyGen';
import { autoPrompts, type AutoOpts } from './auto';
import { refreshProduct, refreshProject, refreshSource } from './collect';
import { generateConcepts, type GenerateOpts } from './concepts';
import { buildCorpus, buildPlaybook } from './corpus';
import { extractCreative } from './extract';
import { syncMarketing, recordManualOutcome, recalibrateWeights } from './outcomes';
import { analyzeUpload, createOutput, nextFromImage, refineOutput } from './outputs';
import { fillProductSheet } from './productSheet';
import { ingestCompetitorAd, ingestOwnAd } from './ingest';
import { buildTemplates } from './templates';
import { nextTemplateVersion, templateCreatives, type TemplateRunOpts } from './templateGen';


async function upsertProduct(p: {
  projectId?: string;
  productId?: string;
  name?: string;
  description?: string;
  benefit?: string;
}) {
  const { db, must } = await import('../db');
  if (p.productId) {
    const row = must(
      await db()
        .from('jev_products')
        .update({
          name: p.name ?? '',
          description: p.description ?? '',
          benefit: p.benefit ?? '',
        })
        .eq('id', p.productId)
        .select('id,name,description,benefit')
        .single(),
    );
    return row;
  }
  if (!p.projectId) throw new Error('projectId required');
  const { data: existing } = await db()
    .from('jev_products')
    .select('id')
    .eq('project_id', p.projectId)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  if (existing?.id) {
    return must(
      await db()
        .from('jev_products')
        .update({
          name: p.name ?? '',
          description: p.description ?? '',
          benefit: p.benefit ?? '',
        })
        .eq('id', existing.id)
        .select('id,name,description,benefit')
        .single(),
    );
  }
  return must(
    await db()
      .from('jev_products')
      .insert({
        project_id: p.projectId,
        name: p.name || 'Default product',
        description: p.description || '',
        benefit: p.benefit || '',
        source_mode: 'same_benefit',
      })
      .select('id,name,description,benefit')
      .single(),
  );
}

export async function runJob(type: string, p: any, jobId: string): Promise<unknown> {
  switch (type) {
    case 'refresh_source': return refreshSource(p.sourceId, jobId);
    case 'refresh_product': return refreshProduct(p.productId, jobId);
    case 'refresh_project': return refreshProject(p.projectId, jobId);
    case 'extract_creative': return extractCreative(p.creativeId, jobId);
    case 'analyze_creative': return analyzeCreative(p.creativeId, jobId);
    case 'analyze_product': return analyzeProduct(p.productId);
    case 'build_corpus': return buildCorpus(p.productId, jobId);
    case 'build_playbook': return buildPlaybook(p.productId, jobId);
    case 'generate_concepts': {
      const { createBatch } = await import('../batches');
      const o = p.opts as GenerateOpts;
      const batchId = await createBatch(p.productId, 'manual', `Concept dalla Shortlist · ${o.kind}${o.combine ? ' · remix' : ''}`, o as unknown as Record<string, unknown>);
      return generateConcepts(p.productId, { ...o, batchId }, jobId);
    }
    case 'create_output': return createOutput(p.conceptId, { language: p.language, variants: p.variants }, jobId);
    case 'analyze_upload': return analyzeUpload(p.outputId, jobId);
    case 'sync_marketing': return syncMarketing(p.productId);
    case 'build_families': return buildImageFeatures(p.productId, jobId);
    case 'family_generate': return familyGenerate(p.productId, p.opts as FamilyGenOpts, jobId);
    case 'hook_variants': return hookVariants(p.productId, p.opts, jobId);
    case 'next_from_image': return nextFromImage(p.outputId, jobId);
    case 'refine_output': return refineOutput(p.outputId, jobId);
    case 'auto_prompts': return autoPrompts(p.productId, p.opts as AutoOpts, jobId);
    case 'reassign_product': return reassignProduct(p.productId, jobId);
    case 'build_templates': return buildTemplates(p.productId, jobId);
    case 'template_creatives': return templateCreatives(p.productId, p.opts as TemplateRunOpts, jobId);
    case 'template_next': return nextTemplateVersion(p.outputId, jobId);
    case 'fill_product_sheet': return fillProductSheet(p.productId, { url: p.url, text: p.text, overwrite: p.overwrite }, jobId);
    case 'ingest_from_competitor_ad': return ingestCompetitorAd(p.projectId, p.competitorAdId, jobId);
    case 'ingest_from_own_ad': return ingestOwnAd(p.projectId, p.ownAdId, jobId);
    case 'record_outcome': {
      const raw = String(p.label || 'unknown');
      const label = raw === 'lose' || raw === 'loss' ? 'loss' : raw === 'win' ? 'win' : 'unknown';
      return recordManualOutcome(p.outputId, label as 'win' | 'loss' | 'unknown');
    }
    case 'recalibrate_weights': return recalibrateWeights(p.productId);
    case 'upsert_product': return upsertProduct(p);
    default: throw new Error(`Unknown job: ${type}`);
  }
}
