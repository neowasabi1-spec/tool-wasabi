/** Brand rules (Jev Brain) stored on projects.brand_rules */

export type BrandRules = {
  tone: string;
  positioning: string;
  palette: string[];
  forbidden: string[];
  required_elements: string[];
  logo_rules: string;
  logo_path: string;
};

export const EMPTY_BRAND_RULES: BrandRules = {
  tone: '',
  positioning: '',
  palette: [],
  forbidden: [],
  required_elements: [],
  logo_rules: '',
  logo_path: '',
};

export function normalizeBrandRules(raw: unknown): BrandRules {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  return {
    tone: String(o.tone ?? '').trim(),
    positioning: String(o.positioning ?? '').trim(),
    palette: strArr(o.palette),
    forbidden: strArr(o.forbidden),
    required_elements: strArr(o.required_elements),
    logo_rules: String(o.logo_rules ?? '').trim(),
    logo_path: String(o.logo_path ?? '').trim(),
  };
}

const bullet = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');

export function brandContext(projectName: string, rules: BrandRules): string {
  return [
    `Brand: ${projectName}`,
    `Positioning: ${rules.positioning || '(undefined)'}`,
    `Tone of voice: ${rules.tone || '(undefined)'}`,
  ].join('\n');
}

export function brandRulesText(rules: BrandRules): string {
  return [
    `Tone: ${rules.tone || '(undefined)'}`,
    `Brand colours (by name): ${rules.palette.join(', ') || '(undefined)'}`,
    `Logo rules: ${rules.logo_rules || '(none)'}`,
    `Forbidden:\n${bullet(rules.forbidden)}`,
    `Mandatory elements:\n${bullet(rules.required_elements)}`,
  ].join('\n');
}
