// Worker-side (CJS) helpers for swiping the live-chat comments that live inside
// the `var TIMED = [...]` array in an inline <script>. DOM text extraction never
// sees them, so without this the swiped page keeps the original (off-product)
// chat copy. Mirrors src/lib/bake-dynamic-comments.ts (extract/apply).

// Locate `var TIMED = [ ... ];` (array literal spanning multiple lines).
const TIMED_RE = /var\s+TIMED\s*=\s*(\[[\s\S]*?\n\s*\])\s*;/;

function parseTimed(arrayLiteral) {
  try {
    // Unquoted keys + JS strings → not valid JSON. Evaluate as a plain array
    // expression. Content is our own cloned page, not third-party input.
    // eslint-disable-next-line no-new-func
    const value = new Function(`return (${arrayLiteral});`)();
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function jsString(s) {
  return JSON.stringify(String(s));
}

// Return the unique comment texts (the `t` field of each TIMED entry).
function extractTimedCommentTexts(html) {
  if (!html || typeof html !== 'string') return [];
  const match = html.match(TIMED_RE);
  if (!match) return [];
  const entries = parseTimed(match[1]);
  if (!entries) return [];
  const out = [];
  const seen = new Set();
  for (const c of entries) {
    const t = (c && c.t ? String(c.t) : '').trim();
    if (t.length < 2 || !/[a-zA-Z]/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Rewrite the `t` field of each TIMED entry using a map original->rewritten,
// rebuilding the array literal safely (JSON-quoted). Must run server-side.
function applyTimedCommentRewrites(html, rewrites) {
  if (!html || typeof html !== 'string') return { html, replaced: 0 };
  const match = html.match(TIMED_RE);
  if (!match) return { html, replaced: 0 };
  const entries = parseTimed(match[1]);
  if (!entries || entries.length === 0) return { html, replaced: 0 };

  const get = (k) => (rewrites instanceof Map ? rewrites.get(k) : rewrites[k]);

  let replaced = 0;
  const rebuilt = entries.map((c) => {
    const t = (c && c.t ? String(c.t) : '').trim();
    const rw = t ? get(t) : undefined;
    if (rw && String(rw).trim() && String(rw).trim() !== t) {
      replaced++;
      return Object.assign({}, c, { t: String(rw).trim() });
    }
    return c;
  });
  if (replaced === 0) return { html, replaced: 0 };

  const literal =
    'var TIMED = [\n' +
    rebuilt
      .map((e) => {
        const parts = [];
        if (e.d !== undefined) parts.push(`d:${e.d}`);
        if (e.n !== undefined) parts.push(`n:${jsString(e.n)}`);
        if (e.t !== undefined) parts.push(`t:${jsString(e.t)}`);
        if (e.isHost) parts.push('isHost:true');
        return '  {' + parts.join(', ') + '}';
      })
      .join(',\n') +
    '\n];';

  // Replacer function so `$` sequences in comment text aren't treated as
  // capture-group references.
  const out = html.replace(match[0], () => literal);
  return { html: out, replaced };
}

module.exports = { extractTimedCommentTexts, applyTimedCommentRewrites };
