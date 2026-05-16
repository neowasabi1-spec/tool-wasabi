// worker-lib/text-extractor.js
//
// Port JS puro di src/lib/universal-text-extractor.ts.
// Usato dal worker in-process, ZERO chiamate HTTP.
//
// Estrae tutti i testi visibili / meta / attributi / json-ld da un HTML.
// Mantenere allineato a src/lib/universal-text-extractor.ts: se cambia
// laggiu' (per la UI), rispecchia qui.

function extractAllTextsUniversal(html) {
  const texts = [];
  const seen = new Set();
  let id = 0;

  function addText(text, context, position = 0) {
    const cleaned = String(text)
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < 2) return;
    const key = `${cleaned}::${context}`;
    if (seen.has(key)) return;
    seen.add(key);
    texts.push({ id: id++, text: cleaned, context, position });
  }

  // 1. TITLE
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  if (titleMatch) addText(titleMatch[1], 'title', titleMatch.index || 0);

  // 2. META (con name/property)
  const metaRegex = /<meta\s+([^>]*?)>/gi;
  let metaMatch;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const attrs = metaMatch[1];
    const contentMatch = attrs.match(/content=["']([^"']+)["']/i);
    if (!contentMatch) continue;
    const httpEquivMatch = attrs.match(/http-equiv=["']([^"']+)["']/i);
    if (httpEquivMatch) continue;
    const nameMatch = attrs.match(/name=["']([^"']+)["']/i);
    const propertyMatch = attrs.match(/property=["']([^"']+)["']/i);
    const key = (nameMatch?.[1] || propertyMatch?.[1] || '').toLowerCase();
    if (!key) continue;
    addText(contentMatch[1], `meta:${key}`, metaMatch.index);
  }

  // 3. tag semplici senza figli
  const simpleTagRegex = /<(\w+)([^>]*)>([^<]+)<\/\1>/gi;
  let simpleMatch;
  while ((simpleMatch = simpleTagRegex.exec(html)) !== null) {
    const tag = simpleMatch[1];
    const content = simpleMatch[3];
    addText(content, `tag:${tag}`, simpleMatch.index);
  }

  // 4. testi misti (tag spezzati)
  const blockRegex = /<(p|div|li|td|th|h[1-6]|span|b|strong|em|i|a)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const tag = blockMatch[1];
    const innerHtml = blockMatch[3];
    const plainText = innerHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plainText.length > 2) addText(plainText, `mixed:${tag}`, blockMatch.index);
  }

  // 5. attributi
  const attrRegex = /\s(alt|title|placeholder|aria-label|value|data-text|data-title|data-content)=["']([^"']+)["']/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(html)) !== null) {
    addText(attrMatch[2], `attr:${attrMatch[1]}`, attrMatch.index);
  }

  // 6. URL
  const urlRegex = /\s(?:href|action)=["']([^"']+)["']/gi;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(html)) !== null) {
    addText(urlMatch[1], 'url', urlMatch.index);
  }

  // 7. email
  const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
  let emailMatch;
  while ((emailMatch = emailRegex.exec(html)) !== null) {
    addText(emailMatch[0], 'email', emailMatch.index);
  }

  // 8. JSON-LD
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const jsonData = JSON.parse(jsonLdMatch[1]);
      function extractFromJson(obj, path = '') {
        if (typeof obj === 'string' && obj.length > 1) {
          addText(obj, `json-ld${path}`, jsonLdMatch.index);
        } else if (Array.isArray(obj)) {
          obj.forEach((item, i) => extractFromJson(item, `${path}[${i}]`));
        } else if (obj && typeof obj === 'object') {
          Object.entries(obj).forEach(([k, v]) => extractFromJson(v, `${path}.${k}`));
        }
      }
      extractFromJson(jsonData);
    } catch {
      const stringRegex = /["']([^"']{2,})["']/g;
      let strM;
      while ((strM = stringRegex.exec(jsonLdMatch[1])) !== null) {
        addText(strM[1], 'json-ld:string', jsonLdMatch.index);
      }
    }
  }

  // 9. stringhe letterali negli <script>
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const content = scriptMatch[1];
    const stringRegex = /["']([^"']{2,200})["']/g;
    let sm;
    while ((sm = stringRegex.exec(content)) !== null) {
      const str = sm[1];
      if (/[a-zA-Z\s]{3,}/.test(str) && !/[{}();=<>]/.test(str)) {
        addText(str, 'script:string', scriptMatch.index);
      }
    }
  }

  // 10. telefoni
  const phoneRegex = /\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g;
  let phoneMatch;
  while ((phoneMatch = phoneRegex.exec(html)) !== null) {
    if (phoneMatch[0].length >= 10) addText(phoneMatch[0], 'phone', phoneMatch.index);
  }

  return texts;
}

module.exports = { extractAllTextsUniversal };
