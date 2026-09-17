/**
 * Park <script>/<style>/<noscript>/<template> so a global string replace
 * on cloned HTML cannot smash JS/CSS.
 *
 * Clone/Swipe used to `html.replace(oldCopy, newCopy)` on the whole file.
 * The same sentence often also sits in a comment-engine array or a JSON
 * config. Replacing it there breaks the script while the visible DOM
 * rewrite would have been enough.
 *
 * Copy that lives in JS string literals is rewritten separately, only
 * inside matching quotes, with JS-safe escaping — so the engine stays
 * valid and the swipe still hits chat/quiz/countdown strings.
 */
const BLOCK_RE =
  /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi;

export function mapHtmlOutsideScripts(
  html: string,
  mapVisible: (visible: string) => string,
  mapScriptBlock?: (block: string) => string,
): string {
  const slots: string[] = [];
  const parked = String(html || '').replace(BLOCK_RE, (m) => {
    const i = slots.length;
    slots.push(m);
    return `<!--__WASABI_JS_${i}__-->`;
  });
  const mapped = mapVisible(parked);
  return mapped.replace(/<!--__WASABI_JS_(\d+)__-->/g, (_, n) => {
    const block = slots[Number(n)] ?? '';
    if (mapScriptBlock && /^<script\b/i.test(block)) return mapScriptBlock(block);
    return block;
  });
}

function escapeJsString(value: string, quote: string): string {
  let out = value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  if (quote === '`') {
    out = out.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  } else {
    out = out.split(quote).join(`\\${quote}`);
  }
  return out;
}

/** Replace `"from"` / `'from'` / `` `from` `` only. Never mutates surrounding JS. */
export function rewriteQuotedJsStrings(
  source: string,
  pairs: Array<{ from: string; to: string }>,
): string {
  let out = source;
  for (const p of pairs) {
    const from = p.from;
    const to = p.to;
    if (!from || from === to) continue;
    if (/['"`\\]/.test(from)) continue;
    for (const q of ['"', "'", '`'] as const) {
      const needle = `${q}${from}${q}`;
      if (!out.includes(needle)) continue;
      out = out.split(needle).join(`${q}${escapeJsString(to, q)}${q}`);
    }
  }
  return out;
}
