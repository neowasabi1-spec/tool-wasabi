/**
 * Bake swipe rewrites INTO the HTML with a real DOM pass (server side).
 *
 * Until now body copy lived only in the injected `data-swipe-replacer` script
 * and was applied at runtime. Any viewer that strips scripts (the Clone/Swipe
 * preview does, exports do, CSP does) showed the OLD page: "not half a word
 * rewritten". This module does what the script does, but on the server, so
 * the saved HTML already carries the new copy. The script stays as a fallback.
 *
 * Matching mirrors the client: element level first (a leaf block whose whole
 * text equals a pair, inline markup allowed), then text-node level, then
 * attributes. Inline structure (<u>, <b>…) is rebuilt when the fragment pairs
 * line up with the parent's rewrite; otherwise the element gets plain text.
 */
import { parse, HTMLElement, TextNode, Node, NodeType } from 'node-html-parser';

export type SwipePair = { from: string; to: string; attr?: string };

export type BakeResult = {
  html: string;
  /** pairs that changed at least one node / attribute */
  applied: number;
  /** non-attr pairs that matched nothing in the DOM */
  unmatched: number;
};

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CODE', 'PRE', 'TEXTAREA', 'HEAD', 'TITLE']);
const CONTAINER_TAGS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TD', 'TH', 'DT', 'DD', 'UL', 'OL', 'TABLE', 'DIV', 'SECTION',
  'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN', 'FORM', 'BLOCKQUOTE', 'FIGURE',
]);
const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'PICTURE', 'SVG', 'IFRAME', 'INPUT', 'SELECT', 'TEXTAREA']);
const KEEP_TAGS = new Set(['A', 'BUTTON', ...MEDIA_TAGS]);
const BLOCK_CANDIDATES = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TD', 'TH', 'DT', 'DD', 'BUTTON', 'A', 'LABEL', 'FIGCAPTION',
  'BLOCKQUOTE', 'SUMMARY', 'LEGEND', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'DIV',
]);

const normWS = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
const keyOf = (s: string) => (s || '').replace(/\s+/g, '');
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Prepared = SwipePair & { norm: string; key: string; rx: RegExp | null; hit: boolean };

function prepare(pairs: SwipePair[]): Prepared[] {
  const out: Prepared[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    if (!p || typeof p.from !== 'string' || typeof p.to !== 'string') continue;
    const norm = normWS(p.from);
    if (norm.length < 2 || norm === normWS(p.to)) continue;
    const id = `${p.attr || ''}\u0000${norm}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let rx: RegExp | null = null;
    try { rx = new RegExp(escRx(norm).replace(/ /g, '\\s*'), 'g'); } catch { rx = null; }
    out.push({ ...p, norm, key: keyOf(norm), rx, hit: false });
  }
  return out;
}

function tagOf(n: Node): string {
  return n.nodeType === NodeType.ELEMENT_NODE ? ((n as HTMLElement).rawTagName || '').toUpperCase() : '';
}

function* walkElements(root: HTMLElement): Generator<HTMLElement> {
  const stack: HTMLElement[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    const tag = tagOf(el);
    if (tag && SKIP_TAGS.has(tag)) continue;
    yield el;
    const kids = el.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k.nodeType === NodeType.ELEMENT_NODE) stack.push(k as HTMLElement);
    }
  }
}

function hasDescendant(el: HTMLElement, tags: Set<string>): boolean {
  for (const d of walkElements(el)) {
    if (d === el) continue;
    if (tags.has(tagOf(d))) return true;
  }
  return false;
}

/** Same rule as the client script: no nested blocks, no interactive/media kids. */
function leafParagraph(el: HTMLElement): boolean {
  if (hasDescendant(el, CONTAINER_TAGS)) return false;
  const tag = tagOf(el);
  return !hasDescendant(el, tag === 'A' || tag === 'BUTTON' ? MEDIA_TAGS : KEEP_TAGS);
}

function textNodesOf(el: HTMLElement): TextNode[] {
  const out: TextNode[] = [];
  const visit = (n: Node) => {
    if (n.nodeType === NodeType.TEXT_NODE) out.push(n as TextNode);
    else if (n.nodeType === NodeType.ELEMENT_NODE && !SKIP_TAGS.has(tagOf(n))) for (const c of n.childNodes) visit(c);
  };
  for (const c of el.childNodes) visit(c);
  return out;
}

/** Decoded visible text of an element (entities resolved, whitespace collapsed). */
function elementText(el: HTMLElement): string {
  return normWS(textNodesOf(el).map((t) => t.text).join(''));
}

/**
 * Rewrite a leaf element to `to`, keeping simple inline wrappers (<u>, <b>,
 * <em>, <span>…) when a fragment pair tells us which words they wrap in the
 * NEW copy. Falls back to plain text.
 */
function rewriteElement(el: HTMLElement, to: string, fragments: Prepared[]): void {
  const inlineKids = el.childNodes.filter((n) => n.nodeType === NodeType.ELEMENT_NODE && tagOf(n) !== 'BR') as HTMLElement[];
  const pieces: Array<{ start: number; end: number; el: HTMLElement; text: string }> = [];
  if (inlineKids.length) {
    let cursor = 0;
    for (const kid of inlineKids) {
      const kidNorm = elementText(kid);
      if (!kidNorm) continue;
      const frag = fragments.find((f) => !f.attr && (f.norm === kidNorm || f.key === keyOf(kidNorm)));
      if (!frag) continue;
      const idx = to.indexOf(frag.to, cursor);
      if (idx < 0) continue;
      pieces.push({ start: idx, end: idx + frag.to.length, el: kid, text: frag.to });
      cursor = idx + frag.to.length;
      frag.hit = true;
    }
  }
  if (!pieces.length) {
    el.set_content(escHtml(to));
    return;
  }
  let html = '';
  let pos = 0;
  for (const p of pieces) {
    html += escHtml(to.slice(pos, p.start));
    const attrs = p.el.rawAttrs ? ` ${p.el.rawAttrs}` : '';
    const tag = (p.el.rawTagName || 'span').toLowerCase();
    html += `<${tag}${attrs}>${escHtml(p.text)}</${tag}>`;
    pos = p.end;
  }
  html += escHtml(to.slice(pos));
  el.set_content(html);
}

function replaceInString(s: string, prepared: Prepared[], minLen = 2): string {
  let out = s;
  for (const p of prepared) {
    if (p.attr || p.norm.length < minLen) continue;
    if (out.includes(p.from)) { out = out.split(p.from).join(p.to); p.hit = true; continue; }
    if (p.rx) {
      p.rx.lastIndex = 0;
      if (p.rx.test(out)) { p.rx.lastIndex = 0; out = out.replace(p.rx, () => p.to); p.hit = true; }
    }
  }
  return out;
}

export function bakePairsDom(html: string, pairs: SwipePair[]): BakeResult {
  const prepared = prepare(pairs);
  if (!prepared.length) return { html, applied: 0, unmatched: 0 };
  // Longest first so a headline is matched before the <u> fragment inside it.
  prepared.sort((a, b) => b.norm.length - a.norm.length);
  const textPairs = prepared.filter((p) => !p.attr);
  const fragments = textPairs.filter((p) => textPairs.some((o) => o !== p && o.norm.length > p.norm.length && o.norm.includes(p.norm)));
  const byKey = new Map<string, Prepared>();
  for (const p of textPairs) if (!byKey.has(p.key)) byKey.set(p.key, p);

  let root: HTMLElement;
  try {
    root = parse(html, {
      comment: true,
      blockTextElements: { script: true, noscript: true, style: true, pre: true, textarea: true },
    });
  } catch {
    return { html, applied: 0, unmatched: textPairs.length };
  }
  const body = root.querySelector('body') || root;

  // Pass 1 — whole leaf elements (inline markup allowed).
  for (const el of walkElements(body)) {
    if (el === body) continue;
    if (!BLOCK_CANDIDATES.has(tagOf(el))) continue;
    const full = elementText(el);
    if (!full) continue;
    const hit = byKey.get(keyOf(full));
    if (!hit) continue;
    if (!leafParagraph(el)) continue;
    rewriteElement(el, hit.to, fragments);
    hit.hit = true;
  }

  // Pass 2 — text nodes: exact fragments, then substrings (brand mentions).
  const touch = (node: TextNode) => {
    const raw = node.text;
    if (!raw || !normWS(raw)) return;
    const norm = normWS(raw);
    const exact = byKey.get(keyOf(norm));
    if (exact) {
      const lead = raw.match(/^\s*/)?.[0] || '';
      const trail = raw.match(/\s*$/)?.[0] || '';
      node.rawText = `${lead}${escHtml(exact.to)}${trail}`;
      exact.hit = true;
      return;
    }
    const next = replaceInString(raw, textPairs, 4);
    if (next !== raw) node.rawText = escHtml(next);
  };
  for (const el of walkElements(body)) {
    for (const c of el.childNodes) if (c.nodeType === NodeType.TEXT_NODE) touch(c as TextNode);
  }

  // Pass 3 — attributes (alt, title, placeholder, aria-label…).
  for (const p of prepared) {
    if (!p.attr) continue;
    for (const el of root.querySelectorAll(`[${p.attr}]`)) {
      const v = el.getAttribute(p.attr);
      if (!v) continue;
      let nv = v;
      if (v.includes(p.from)) nv = v.split(p.from).join(p.to);
      else if (p.rx) { p.rx.lastIndex = 0; if (p.rx.test(v)) { p.rx.lastIndex = 0; nv = v.replace(p.rx, () => p.to); } }
      if (nv !== v) { el.setAttribute(p.attr, nv); p.hit = true; }
    }
  }

  // <title>
  const title = root.querySelector('title');
  if (title) {
    const t = title.text;
    const nt = replaceInString(t, textPairs, 2);
    if (nt !== t) title.set_content(escHtml(nt));
  }

  const applied = prepared.filter((p) => p.hit).length;
  const unmatched = textPairs.filter((p) => !p.hit).length;
  return { html: root.toString(), applied, unmatched };
}

export { escAttr as escapeAttribute };
