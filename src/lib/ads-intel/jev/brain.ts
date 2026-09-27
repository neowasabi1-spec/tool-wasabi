import { db, must } from './db';
import type { Product, Project } from './types';

export async function loadProject(id: string): Promise<Project> {
  const row = must(await db().from('projects').select('*').eq('id', id).single()) as Record<string, unknown>;
  const br = (row.brand_rules && typeof row.brand_rules === 'object' ? row.brand_rules : {}) as Record<string, unknown>;
  const strArr = (v: unknown, fallback: unknown) => {
    if (Array.isArray(v) && v.length) return v.map(String);
    if (Array.isArray(fallback)) return fallback.map(String);
    return [] as string[];
  };
  return {
    id: String(row.id),
    name: String(row.name || ''),
    tone: String(br.tone ?? row.tone ?? ''),
    positioning: String(br.positioning ?? row.positioning ?? ''),
    palette: strArr(br.palette, row.palette),
    logo_rules: String(br.logo_rules ?? row.logo_rules ?? ''),
    logo_path: (br.logo_path as string) || (row.logo_path as string) || null,
    forbidden: strArr(br.forbidden, row.forbidden),
    required_elements: strArr(br.required_elements, row.required_elements),
  };
}

export async function loadProduct(id: string): Promise<{ product: Product; project: Project }> {
  const product = must(await db().from('jev_products').select('*').eq('id', id).single()) as Product;
  return { product, project: await loadProject(product.project_id) };
}

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (nessuno)');

export function brandContext(project: Project, product?: Product): string {
  return [
    `Brand: ${project.name}`,
    `Positioning: ${project.positioning || '(non definito)'}`,
    `Tone of voice: ${project.tone || '(non definito)'}`,
    product ? `Product: ${product.name} — ${product.description}` : '',
    product?.benefit ? `Core benefit: ${product.benefit}` : '',
    product?.mechanism ? `How it works: ${product.mechanism}` : '',
    product?.avatar ? `Audience / avatar: ${product.avatar}` : '',
    product?.offer ? `Offer: ${product.offer}` : '',
  ].filter(Boolean).join('\n');
}

/** Scheda completa del NOSTRO prodotto: l'unica fonte di verità sui fatti di prodotto. */
export function productSheet(product: Product): string {
  const f = (label: string, v: string) => (v?.trim() ? `${label}:\n${v.trim()}` : '');
  return [
    `Product: ${product.name}`,
    f('Description', product.description),
    f('Core benefit', product.benefit),
    f('Mechanism (how it works)', product.mechanism),
    f('Ingredients / features', product.features),
    f('Available proof', product.proof),
    f('Differentiators vs other products with the same benefit', product.differentiators),
    f('Offer', product.offer),
    f('Guarantee', product.guarantee),
    f('Audience / avatar', product.avatar),
    f('Detailed product explanation', product.product_sheet),
  ].filter(Boolean).join('\n\n');
}

/** Istruzioni di adattamento in base alla modalità delle fonti. */
export function modeInstructions(product: Product): string {
  if (product.source_mode === 'same_product') {
    return 'SOURCE MODE: SAME PRODUCT. The source ads promote the very same product we sell. Product facts, mechanism and proof they mention are true for our product too and may be reused as facts (never copy wording or execution). Differentiate on angle, hook and execution, not on the product.';
  }
  return `SOURCE MODE: SAME BENEFIT, DIFFERENT PRODUCTS. The source ads sell OTHER products that promise the same benefit${product.benefit ? ` ("${product.benefit}")` : ''}. ` +
    'Keep the desire, the benefit and the persuasion mechanism. REPLACE their product, their mechanism, their ingredients/features, their proof and their offer with OURS from the product sheet. ' +
    'Never attribute to our product any feature, ingredient, result or proof that is not in the product sheet. ' +
    'Where their argument depends on something our product does not have, rebuild the argument on our own mechanism or differentiators.';
}

export function brandRules(project: Project, product?: Product): string {
  return [
    `Tone: ${project.tone || '(non definito)'}`,
    `Brand colours (by name): ${project.palette.join(', ') || '(non definiti)'}`,
    `Logo rules: ${project.logo_rules || '(nessuna)'}`,
    `Forbidden:\n${list([...project.forbidden, ...(product?.forbidden ?? [])])}`,
    `Mandatory elements:\n${list([...project.required_elements, ...(product?.required_elements ?? [])])}`,
  ].join('\n');
}

export function productsText(products: Pick<Product, 'id' | 'name' | 'description'>[]): string {
  return products.map((p) => `- ${p.name}: ${p.description}`).join('\n') || '(nessun prodotto)';
}

export async function latestPlaybook(productId: string): Promise<{ text: string; content: any; version: number } | null> {
  const { data } = await db().from('jev_playbooks').select('*').eq('product_id', productId).order('version', { ascending: false }).limit(1).maybeSingle();
  return data ? { text: data.text, content: data.content, version: data.version } : null;
}
