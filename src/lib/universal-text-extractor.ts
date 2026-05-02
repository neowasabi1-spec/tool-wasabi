// Universal Text Extractor - Cattura TUTTI i testi da HTML
// Include testi spezzati, misti, URL, email, attributi, tutto

export interface ExtractedText {
  id: number;
  text: string;
  context: string; // dove è stato trovato
  position: number;
}

export function extractAllTextsUniversal(html: string): ExtractedText[] {
  const texts: ExtractedText[] = [];
  const seen = new Set<string>();
  let id = 0;

  function addText(text: string, context: string, position: number = 0) {
    // Pulizia base
    const cleaned = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

    // Validazione minima - solo lunghezza
    if (cleaned.length < 2) return;
    
    // Evita duplicati esatti
    const key = `${cleaned}::${context}`;
    if (seen.has(key)) return;
    seen.add(key);

    texts.push({
      id: id++,
      text: cleaned,
      context,
      position
    });
  }

  // 1. TITLE TAG
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  if (titleMatch) {
    addText(titleMatch[1], 'title', titleMatch.index || 0);
  }

  // 2. META TAGS — tipizzati con name/property così a valle possiamo accettare
  // solo i meta davvero marketing-utili (description, og:title/description,
  // twitter:title/description) ed escludere viewport/cache-control/charset/ecc.
  const metaRegex = /<meta\s+([^>]*?)>/gi;
  let metaMatch;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const attrs = metaMatch[1];
    const contentMatch = attrs.match(/content=["']([^"']+)["']/i);
    if (!contentMatch) continue;
    const nameMatch = attrs.match(/name=["']([^"']+)["']/i);
    const propertyMatch = attrs.match(/property=["']([^"']+)["']/i);
    const httpEquivMatch = attrs.match(/http-equiv=["']([^"']+)["']/i);
    if (httpEquivMatch) continue; // cache-control, content-type, refresh: mai copy
    const key = (nameMatch?.[1] || propertyMatch?.[1] || '').toLowerCase();
    if (!key) continue;
    // emetti come "meta:NAME" così filterAndCap può whitelist-are
    addText(contentMatch[1], `meta:${key}`, metaMatch.index);
  }

  // 3. TUTTI I CONTENUTI DI TAG (anche con HTML interno)
  // Prima passa: tag semplici senza figli
  const simpleTagRegex = /<(\w+)([^>]*)>([^<]+)<\/\1>/gi;
  let simpleMatch;
  while ((simpleMatch = simpleTagRegex.exec(html)) !== null) {
    const tag = simpleMatch[1];
    const content = simpleMatch[3];
    addText(content, `tag:${tag}`, simpleMatch.index);
  }

  // 4. TESTI MISTI (il caso difficile: testo spezzato tra tag)
  // Strategia: rimuovi tutti i tag inline e prendi il testo risultante
  const blockRegex = /<(p|div|li|td|th|h[1-6]|span|b|strong|em|i|a)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const tag = blockMatch[1];
    const innerHtml = blockMatch[3];
    
    // Rimuovi TUTTI i tag interni e tieni solo il testo
    const plainText = innerHtml
      .replace(/<[^>]+>/g, ' ') // rimuovi tutti i tag
      .replace(/\s+/g, ' ')
      .trim();
    
    if (plainText.length > 2) {
      addText(plainText, `mixed:${tag}`, blockMatch.index);
    }
  }

  // 5. ATTRIBUTI - tutti i tipi
  const attrRegex = /\s(alt|title|placeholder|aria-label|value|data-text|data-title|data-content)=["']([^"']+)["']/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(html)) !== null) {
    addText(attrMatch[2], `attr:${attrMatch[1]}`, attrMatch.index);
  }

  // 6. URL negli href e action
  const urlRegex = /\s(?:href|action)=["']([^"']+)["']/gi;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(html)) !== null) {
    const url = urlMatch[1];
    addText(url, 'url', urlMatch.index);
  }

  // 7. EMAIL ADDRESSES ovunque
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
      
      function extractFromJson(obj: any, path: string = '') {
        if (typeof obj === 'string' && obj.length > 1) {
          addText(obj, `json-ld${path}`, jsonLdMatch.index);
        } else if (Array.isArray(obj)) {
          obj.forEach((item, i) => extractFromJson(item, `${path}[${i}]`));
        } else if (obj && typeof obj === 'object') {
          Object.entries(obj).forEach(([key, value]) => {
            extractFromJson(value, `${path}.${key}`);
          });
        }
      }
      
      extractFromJson(jsonData);
    } catch (e) {
      // Se non è JSON valido, prova a estrarre stringhe
      const stringRegex = /["']([^"']{2,})["']/g;
      let stringMatch;
      while ((stringMatch = stringRegex.exec(jsonLdMatch[1])) !== null) {
        addText(stringMatch[1], 'json-ld:string', jsonLdMatch.index);
      }
    }
  }

  // 9. TESTI IN SCRIPT (stringhe letterali)
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const content = scriptMatch[1];
    
    // Estrai stringhe quotate
    const stringRegex = /["']([^"']{2,200})["']/g;
    let stringMatch;
    while ((stringMatch = stringRegex.exec(content)) !== null) {
      const str = stringMatch[1];
      // Solo se sembra testo naturale
      if (/[a-zA-Z\s]{3,}/.test(str) && !/[{}();=<>]/.test(str)) {
        addText(str, 'script:string', scriptMatch.index);
      }
    }
  }

  // 10. NUMERI DI TELEFONO
  const phoneRegex = /\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g;
  let phoneMatch;
  while ((phoneMatch = phoneRegex.exec(html)) !== null) {
    if (phoneMatch[0].length >= 10) { // numero valido
      addText(phoneMatch[0], 'phone', phoneMatch.index);
    }
  }

  return texts;
}