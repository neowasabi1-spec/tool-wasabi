import { NextRequest, NextResponse } from 'next/server';
import { requireAnthropicKey } from '@/lib/anthropic-key';

export const maxDuration = 120;

interface ProductInfo {
  name: string;
  description?: string;
  benefits?: string[];
  target_audience?: string;
  price?: string;
  cta_text?: string;
  cta_url?: string;
  brand_name?: string;
  social_proof?: string;
}

interface ExtractedText {
  original: string;
  tag: string;
  position: number;
}

function extractTextsFromHtml(html: string): ExtractedText[] {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  const bodyMatch = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : stripped;

  const texts: ExtractedText[] = [];
  const seen = new Set<string>();

  const textTags = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'li', 'td', 'th', 'dt', 'dd',
    'button', 'a', 'label', 'figcaption',
    'blockquote', 'summary', 'legend',
  ];

  const blockTags = new Set([
    'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'blockquote', 'figure', 'figcaption', 'form', 'fieldset',
    'button', 'details', 'summary',
  ]);

  for (const tag of textTags) {
    const regex = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = regex.exec(bodyHtml)) !== null) {
      const innerHTML = match[2];
      const plain = innerHTML.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain.length < 2 || !/[a-zA-Z]/.test(plain)) continue;
      if (seen.has(plain)) continue;
      if (plain.includes('{') && plain.includes('}') && plain.includes('=>')) continue;

      const hasBlockChild = Array.from(innerHTML.matchAll(/<(div|section|article|p|h[1-6]|ul|ol|li|table|tr|td|th|blockquote|form|button)[^>]*>/gi))
        .some((m) => {
          const childTag = m[1].toLowerCase();
          if (!blockTags.has(childTag)) return false;
          const childContent = innerHTML.slice(m.index! + m[0].length);
          const closeIdx = childContent.indexOf(`</${childTag}`);
          if (closeIdx === -1) return false;
          const childText = childContent.slice(0, closeIdx).replace(/<[^>]*>/g, '').trim();
          return childText.length >= 2;
        });
      if (hasBlockChild) continue;

      seen.add(plain);
      texts.push({ original: plain, tag, position: match.index || 0 });
    }
  }

  const inlineRegex = /<(span|div|strong|em|b|i)([^>]*)>([^<]{3,500})<\/\1>/gi;
  let inMatch;
  while ((inMatch = inlineRegex.exec(bodyHtml)) !== null) {
    const text = inMatch[3].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 3 || !/[a-zA-Z]/.test(text) || seen.has(text)) continue;
    seen.add(text);
    texts.push({ original: text, tag: inMatch[1], position: inMatch.index || 0 });
  }

  const attrRegex = /(alt|title|placeholder|aria-label)=["']([^"']{3,200})["']/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(bodyHtml)) !== null) {
    const val = attrMatch[2].trim();
    if (val.length < 3 || !/[a-zA-Z]/.test(val) || seen.has(val) || val.startsWith('http')) continue;
    seen.add(val);
    texts.push({ original: val, tag: `attr:${attrMatch[1]}`, position: 0 });
  }

  return texts;
}

function cleanAiOutput(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  const jsonStart = cleaned.indexOf('[');
  const jsonEnd = cleaned.lastIndexOf(']');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }
  return cleaned.trim();
}

async function callAnthropicFallback(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = requireAnthropicKey();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.substring(0, 300)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function clonePageHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch page: HTTP ${res.status}`);
  let html = await res.text();
  return absolutizeUrls(html, url);
}

function makeAbsolute(path: string, origin: string, basePath: string, protocol: string): string {
  const trimmed = path.trim();
  if (!trimmed || /^(https?:\/\/|data:|#|mailto:|javascript:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return protocol + trimmed;
  if (trimmed.startsWith('/')) return origin + trimmed;
  return basePath + trimmed;
}

function fixMediaLoading(html: string): string {
  let fixed = html.replace(/loading=["']lazy["']/gi, 'loading="eager"');
  fixed = fixed.replace(/<img\b/gi, '<img referrerpolicy="no-referrer" ');
  fixed = fixed.replace(/<video\b/gi, '<video referrerpolicy="no-referrer" ');
  fixed = fixed.replace(/<source\b/gi, '<source referrerpolicy="no-referrer" ');
  if (fixed.includes('<head>')) {
    fixed = fixed.replace('<head>', '<head><meta name="referrer" content="no-referrer">');
  } else if (fixed.includes('<head ')) {
    fixed = fixed.replace(/<head\s/i, '<head><meta name="referrer" content="no-referrer"></head><head ');
  } else {
    fixed = '<meta name="referrer" content="no-referrer">' + fixed;
  }
  return fixed;
}

function absolutizeUrls(html: string, baseUrl: string): string {
  const urlObj = new URL(baseUrl);
  const origin = urlObj.origin;
  const basePath = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  const protocol = urlObj.protocol;

  return html
    .replace(/(srcset)=(["'])(.*?)\2/gi, (_match, attr, quote, value) => {
      if (/^\s*(https?:\/\/|\/\/)/i.test(value)) return `${attr}=${quote}${value}${quote}`;
      const fixed = value.split(/,(?=\s)/).map((entry: string) => {
        const parts = entry.trim().split(/\s+/);
        if (parts.length === 0) return entry;
        parts[0] = makeAbsolute(parts[0], origin, basePath, protocol);
        return parts.join(' ');
      }).join(', ');
      return `${attr}=${quote}${fixed}${quote}`;
    })
    .replace(/(src|href|poster|data-src|data-lazy-src)=(["'])((?!https?:\/\/|data:|#|mailto:|javascript:|\/\/).*?)\2/gi,
      (_match, attr, quote, path) => {
        return `${attr}=${quote}${makeAbsolute(path, origin, basePath, protocol)}${quote}`;
      })
    .replace(/url\((['"]?)((?!https?:\/\/|data:|#)(?:\/[^)'"]+|[^)'"\s]+))\1\)/gi,
      (_match, quote, path) => {
        return `url(${quote}${makeAbsolute(path, origin, basePath, protocol)}${quote})`;
      });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { source_url, html: providedHtml, product, tone, language } = body as {
      source_url?: string;
      html?: string;
      product: ProductInfo;
      tone?: string;
      language?: string;
    };

    if (!source_url && !providedHtml) {
      return NextResponse.json({ error: 'source_url or html required' }, { status: 400 });
    }
    if (!product?.name) {
      return NextResponse.json({ error: 'product.name required' }, { status: 400 });
    }

    let originalHtml: string;
    if (providedHtml) {
      originalHtml = source_url ? absolutizeUrls(providedHtml, source_url) : providedHtml;
    } else {
      originalHtml = await clonePageHtml(source_url!);
    }
    originalHtml = fixMediaLoading(originalHtml);
    if (originalHtml.length < 50) {
      return NextResponse.json({ error: 'HTML too short' }, { status: 400 });
    }

    const texts = extractTextsFromHtml(originalHtml);
    if (texts.length === 0) {
      return NextResponse.json({ error: 'No text found in page' }, { status: 400 });
    }

    const textsForAi = texts.map((t, i) => ({ id: i, text: t.original, tag: t.tag }));

    const productDesc = [
      product.description || '',
      product.benefits?.length ? `Benefits: ${product.benefits.join(', ')}` : '',
      product.brand_name ? `Brand: ${product.brand_name}` : '',
      product.price ? `Price: ${product.price}` : '',
      product.cta_text ? `CTA: ${product.cta_text}` : '',
      product.target_audience ? `Target: ${product.target_audience}` : '',
    ].filter(Boolean).join('\n');

    const lang = language || 'it';
    const toneStr = tone || 'professional';

    const systemPrompt = `You are a world-class direct-response copywriter. You rewrite marketing texts to sell a SPECIFIC product while keeping the EXACT SAME structure, tone, style, length, and persuasion techniques.

PRODUCT: ${product.name}
${productDesc}

TONE: ${toneStr}
LANGUAGE: ${lang === 'it' ? 'Italian' : lang === 'en' ? 'English' : lang}

CRITICAL RULES:
1. Rewrite ONLY the text content. ALL images, videos, media, and HTML structure are preserved separately.
2. Keep the same emotional angle, copywriting technique, and approximate length (±20%).
3. Keep the same language/tone (casual→casual, urgent→urgent, formal→formal).
4. Do NOT add markdown, HTML tags, or formatting — return PLAIN TEXT only.
5. Button labels, CTAs, short phrases → keep short and punchy.
6. Structural text ("Step 1", "FAQ", numbers) → keep unchanged or adapt minimally.
7. Return a JSON array: [{"id": 0, "rewritten": "new text"}, ...]
8. Return ONLY the JSON array, nothing else.`;

    const userPrompt = `Rewrite these ${texts.length} texts for "${product.name}":\n\n${JSON.stringify(textsForAi, null, 2)}`;

    let aiText = '';
    const usedProvider = 'anthropic';

    try {
      console.log(`[swipe] Sending to Anthropic, texts=${texts.length}`);
      aiText = await callAnthropicFallback(systemPrompt, userPrompt);
      if (!aiText.trim()) throw new Error('Empty response from Anthropic');
      console.log(`[swipe] Anthropic OK, response: ${aiText.length} chars`);
    } catch (anthropicErr) {
      console.error(`[swipe] Anthropic failed: ${anthropicErr instanceof Error ? anthropicErr.message : 'Unknown'}`);
      return NextResponse.json({
        error: `Anthropic failed: ${anthropicErr instanceof Error ? anthropicErr.message : 'Unknown'}`,
      }, { status: 502 });
    }

    const cleaned = cleanAiOutput(aiText);

    let rewrites: Array<{ id: number; rewritten: string }>;
    try {
      rewrites = JSON.parse(cleaned);
    } catch {
      return NextResponse.json({ error: 'AI returned invalid JSON', raw: cleaned.substring(0, 500) }, { status: 500 });
    }

    const replacementPairs: Array<{ from: string; to: string; attr?: string }> = [];
    for (const rw of rewrites) {
      const original = texts[rw.id];
      if (!original || !rw.rewritten || original.original === rw.rewritten) continue;
      if (original.tag.startsWith('attr:')) {
        replacementPairs.push({ from: original.original, to: rw.rewritten, attr: original.tag.replace('attr:', '') });
      } else {
        replacementPairs.push({ from: original.original, to: rw.rewritten });
      }
    }

    const swipeScript = `<script data-swipe-replacer>
(function(){
  var pairs = ${JSON.stringify(replacementPairs)};
  function walkText(node){
    if(node.nodeType===3){
      var t=node.textContent;
      for(var i=0;i<pairs.length;i++){
        if(!pairs[i].attr&&t.indexOf(pairs[i].from)!==-1){
          t=t.split(pairs[i].from).join(pairs[i].to);
        }
      }
      if(t!==node.textContent)node.textContent=t;
    }else if(node.nodeType===1&&node.tagName!=='SCRIPT'&&node.tagName!=='STYLE'){
      for(var c=node.firstChild;c;c=c.nextSibling)walkText(c);
    }
  }
  walkText(document.body);
  for(var i=0;i<pairs.length;i++){
    if(pairs[i].attr){
      var els=document.querySelectorAll('['+pairs[i].attr+']');
      for(var j=0;j<els.length;j++){
        var v=els[j].getAttribute(pairs[i].attr);
        if(v&&v.indexOf(pairs[i].from)!==-1){
          els[j].setAttribute(pairs[i].attr,v.split(pairs[i].from).join(pairs[i].to));
        }
      }
    }
  }
  var titleEl=document.querySelector('title');
  if(titleEl){
    var tt=titleEl.textContent;
    for(var i=0;i<pairs.length;i++){
      if(!pairs[i].attr&&tt.indexOf(pairs[i].from)!==-1){
        tt=tt.split(pairs[i].from).join(pairs[i].to);
      }
    }
    titleEl.textContent=tt;
  }
})();
<\/script>`;

    let resultHtml = originalHtml;
    if (resultHtml.includes('</body>')) {
      resultHtml = resultHtml.replace('</body>', swipeScript + '</body>');
    } else {
      resultHtml += swipeScript;
    }

    const newTitle = texts.length > 0 ? (replacementPairs.find(p => !p.attr)?.to || '') : '';

    return NextResponse.json({
      success: true,
      html: resultHtml,
      original_title: originalHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '',
      new_title: newTitle,
      original_length: originalHtml.length,
      new_length: resultHtml.length,
      totalTexts: texts.length,
      replacements: replacementPairs.length,
      provider: usedProvider,
      method_used: 'dom-replacement',
      changes_made: replacementPairs.map(p => ({ from: p.from.substring(0, 50), to: p.to.substring(0, 50) })),
    });
  } catch (error) {
    console.error('Swipe error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error during swipe' },
      { status: 500 },
    );
  }
}
