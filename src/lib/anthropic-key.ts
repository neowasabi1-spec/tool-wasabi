/**
 * Read the ANTHROPIC_API_KEY from env and normalize it.
 * Handles common malformations:
 *   - surrounding double/single quotes (e.g. `"sk-ant-..."`)
 *   - leading/trailing whitespace or newlines
 *   - invisible BOM/zero-width characters
 */
export function getAnthropicKey(): string {
  const raw = process.env.ANTHROPIC_API_KEY || '';
  let k = raw.trim();
  // strip quotes if the whole value is wrapped
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }
  // strip BOM / zero-width / non-printable chars
  k = k.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200d\ufeff]/g, '');
  return k.trim();
}

export function requireAnthropicKey(): string {
  const k = getAnthropicKey();
  if (!k) throw new Error('ANTHROPIC_API_KEY is not configured');
  if (!k.startsWith('sk-ant-')) {
    throw new Error(`ANTHROPIC_API_KEY has invalid format (should start with sk-ant-, got: ${k.substring(0, 10)}...)`);
  }
  return k;
}
