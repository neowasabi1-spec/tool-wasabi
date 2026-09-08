/**
 * DOM-based extraction of the VISIBLE COPY of a page, for the swipe rewrite.
 *
 * Why not the regex extractor (universal-text-extractor)? Its "mixed" pass is
 * a single global regex with a lazy match: after it matches `<div>` … first
 * `</div>`, the cursor has skipped every nested div in between, so on
 * page-builder markup (everything is a div in a div) most paragraphs are
 * simply never seen — they stay in the old product's words after a swipe.
 *
 * Here the page is parsed and every text-bearing node is visited exactly once.
 * For each element we emit:
 *   - its inline RUNS: maximal sequences of text + inline children (the
 *     sentence "<b>Overpronation</b> occurs when your foot rolls inward…"),
 *     tagged `mixed:<tag>` — the unit the model should rewrite coherently;
 *   - its direct TEXT NODES, tagged `tag:<tag>` — the unit the DOM replacer
 *     can always swap, even when the element also contains block children.
 * Inline elements are visited recursively, so `<b>` / `<span>` fragments are
 * emitted too and get linked to their run by orderAndLinkFragments.
 */
import { parse, HTMLElement, Node, NodeType } from 'node-html-parser';

export interface DomText {
  text: string;
  /** `title`, `tag:<tag>` (single text node) or `mixed:<tag>` (inline run). */
  context: string;
  /** Character offset in the source HTML — document order for batching. */
  position: number;
}

const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template', 'head', 'iframe', 'canvas', 'video', 'audio', 'picture', 'source', 'code', 'pre', 'textarea', 'select', 'option']);
const INLINE = new Set(['a', 'b', 'strong', 'em', 'i', 'u', 'span', 'small', 'mark', 'cite', 'q', 'abbr', 'sup', 'sub', 'br', 'font', 'label', 'time', 'wbr', 's', 'del', 'ins', 'big', 'tt', 'var', 'dfn', 'kbd', 'samp', 'bdi', 'bdo', 'data', 'output']);

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

const norm = (s: string) => decodeEntities(s).replace(/\s+/g, ' ').trim();

/** textContent, but with a space where a child element boundary was
 *  ("<b>1</b><u>Collapsed</u>" → "1 Collapsed", not "1Collapsed"). */
function textWithSpaces(n: Node): string {
  if (n.nodeType === NodeType.TEXT_NODE) return n.rawText;
  if (n.nodeType !== NodeType.ELEMENT_NODE) return '';
  const el = n as HTMLElement;
  if (SKIP.has((el.rawTagName || '').toLowerCase())) return '';
  return el.childNodes.map(textWithSpaces).join(' ');
}

function isVisibleText(t: string): boolean {
  return t.length >= 3 && /[a-zA-ZÀ-ÿ]/.test(t);
}

export function extractTextsDom(html: string): DomText[] {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } });
  const out: DomText[] = [];
  const seen = new Set<string>();
  const emit = (text: string, context: string, position: number) => {
    const t = norm(text);
    if (!isVisibleText(t)) return;
    const key = `${t}::${context}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, context, position });
  };

  const title = root.querySelector('title');
  if (title) emit(title.textContent, 'title', title.range?.[0] ?? 0);

  // An inline tag that wraps blocks (a card-sized <a>, a <span> around divs)
  // is a container, not part of a sentence.
  const isInline = (n: Node): boolean => {
    if (n.nodeType === NodeType.TEXT_NODE) return true;
    if (!(n instanceof HTMLElement) || !INLINE.has(n.rawTagName?.toLowerCase() || '')) return false;
    return !n.childNodes.some((c) => c.nodeType === NodeType.ELEMENT_NODE && !isInline(c));
  };

  const visit = (el: HTMLElement) => {
    const tag = (el.rawTagName || '').toLowerCase();
    if (SKIP.has(tag)) return;
    if (tag && el.getAttribute('hidden') != null) return;
    const kids = el.childNodes;
    const pos = el.range?.[0] ?? 0;

    // Inline runs: consecutive text/inline children form one readable unit.
    let run: Node[] = [];
    const flushRun = () => {
      if (!run.length) return;
      const hasElement = run.some((n) => n.nodeType === NodeType.ELEMENT_NODE);
      const text = run.map(textWithSpaces).join(' ');
      // A run that is one bare text node is the element's own text (tag:);
      // a run with inline children is a mixed sentence (mixed:).
      emit(text, `${hasElement ? 'mixed' : 'tag'}:${tag || 'div'}`, pos);
      run = [];
    };
    for (const k of kids) {
      if (isInline(k)) run.push(k);
      else flushRun();
    }
    flushRun();

    // Direct text nodes as their own units (the replacer swaps these even when
    // the element mixes text with block children).
    for (const k of kids) {
      if (k.nodeType === NodeType.TEXT_NODE) emit(k.rawText, `tag:${tag || 'div'}`, pos);
    }

    for (const k of kids) {
      if (k.nodeType === NodeType.ELEMENT_NODE) visit(k as HTMLElement);
    }
  };

  const body = root.querySelector('body') || root;
  visit(body as HTMLElement);
  return out;
}
