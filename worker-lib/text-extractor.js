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

  // 8. JSON-LD (whitelist di chiavi semanticamente utili)
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  const usefulJsonLdKeys = new Set([
    'name','description','headline','alternativename','disambiguatingdescription',
    'caption','text','abstract','review','reviewbody','comment','slogan','keywords','genre','category',
  ]);
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const jsonData = JSON.parse(jsonLdMatch[1]);
      function visit(obj, path = '') {
        if (typeof obj === 'string') {
          const lastKey = (path.split('.').pop() || '').toLowerCase();
          if (usefulJsonLdKeys.has(lastKey) && obj.length >= 3 && obj.length < 1000 && /[a-zA-ZàèéìòùÀÈÉÌÒÙ]/.test(obj) && !/^https?:\/\//.test(obj)) {
            addText(obj, `json-ld:${lastKey}`, jsonLdMatch.index);
          }
        } else if (Array.isArray(obj)) {
          obj.forEach((item, i) => visit(item, `${path}[${i}]`));
        } else if (obj && typeof obj === 'object') {
          Object.entries(obj).forEach(([k, v]) => visit(v, path ? `${path}.${k}` : k));
        }
      }
      visit(jsonData);
    } catch {/* malformed JSON-LD, ignore */}
  }

  // 9. <noscript> content (testi visibili a screen reader / SEO bot)
  const noscriptRegex = /<noscript[^>]*>([\s\S]*?)<\/noscript>/gi;
  let noscriptMatch;
  while ((noscriptMatch = noscriptRegex.exec(html)) !== null) {
    const inner = noscriptMatch[1];
    const plain = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain.length >= 2) addText(plain, 'noscript', noscriptMatch.index);
  }

  // 10. SPA JSON inline (Next.js __NEXT_DATA__, Nuxt __NUXT__, SvelteKit
  // __sveltekit_data, Remix __remixContext, ogni <script type="application/json">).
  // Su SPA che non hanno SSR dei tag visibili (quiz tipo Bioma, Typeform-like, ecc.)
  // i testi reali (domande, opzioni, label bottoni, headline, hero) vivono SOLO qui.
  // Filtro pesante per evitare ID / token / class / URL / path / colori.
  const spaJsonRegex = /<script\b[^>]*\stype=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const usefulKeysSpa = new Set([
    'title','subtitle','heading','subheading','headline','tagline',
    'label','text','content','body','message','description',
    'placeholder','value','name','caption','copy','note','helptext',
    'question','questions','answer','answers','option','options',
    'choice','choices','button','buttontext','cta','ctatext',
    'submitlabel','nextlabel','backlabel','errormessage',
    'hero','subhero','benefit','benefits','feature','features',
    'testimonial','testimonials','faq','question_text','answer_text',
    'price','pricelabel','discount','badge','tag','eyebrow',
    'disclaimer','footer','legal',
  ]);
  const blacklistKeysSpa = new Set([
    'id','key','_id','uid','guid','slug','href','url','src',
    'image','imageurl','imagesrc','asset','avatar','icon','iconname',
    'type','kind','variant','classname','classnames','tag_name',
    'color','bgcolor','fontfamily','fontsize','theme',
    'aspath','path','route','pathname','search','query','querystring',
    'token','csrftoken','apikey','sessionid','visitorid',
    'event','eventname','analyticsid','gtmid','pixelid',
    'lang','locale','language','timezone','currency','country',
    'createdat','updatedat','timestamp','expiresat','date',
    'width','height','size','maxlength','minlength','min','max',
    'order','position','index','ordinal','step','count',
    'enabled','disabled','visible','hidden','required','active',
    'mime','mimetype','format','encoding','extension',
  ]);
  function looksLikeCode(s) {
    if (/^https?:\/\//i.test(s)) return true;
    if (/^data:[a-z]+\//i.test(s)) return true;
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)) return true;
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return true;
    if (/^[a-z][a-z0-9_-]{0,40}$/i.test(s) && s.length < 25 && !/\s/.test(s)) return true;
    if (/^[A-Z_]+$/.test(s) && s.length < 30) return true;
    if (/\{\{|\$\{|\bvar\b|\bfunction\b|\breturn\b|=>|\bconst\b|\blet\b/.test(s)) return true;
    if (/^[\d.,\s%/()\-+*=<>!?]+$/.test(s)) return true;
    return false;
  }
  function isHumanText(s) {
    if (s.length < 3 || s.length > 800) return false;
    const letters = s.match(/[a-zA-ZàèéìòùÀÈÉÌÒÙáéíóúÁÉÍÓÚñÑ]/g)?.length || 0;
    if (letters < 3) return false;
    if (letters / s.length < 0.4) return false;
    const words = s.trim().split(/\s+/);
    if (words.length === 1 && s.length < 4) return false;
    return true;
  }
  let spaJsonMatch;
  while ((spaJsonMatch = spaJsonRegex.exec(html)) !== null) {
    const rawJson = spaJsonMatch[1].trim();
    if (rawJson.length < 50) continue;
    let parsed;
    try { parsed = JSON.parse(rawJson); } catch { continue; }
    const seenInScript = new Set();
    function visitSpa(node, parentKey, depth) {
      if (depth > 25 || node == null) return;
      if (typeof node === 'string') {
        const lkey = (parentKey || '').toLowerCase();
        if (blacklistKeysSpa.has(lkey)) return;
        if (lkey.endsWith('id') || lkey.endsWith('url') || lkey.endsWith('src') || lkey.endsWith('href') || lkey.endsWith('class')) return;
        const trimmed = node.trim();
        if (!isHumanText(trimmed)) return;
        if (looksLikeCode(trimmed)) return;
        const useful = usefulKeysSpa.has(lkey)
          || /text|label|title|content|copy|description|question|answer|option|button|cta|message|hero|head/i.test(parentKey);
        if (!useful) {
          if (trimmed.length < 12 || !/\s/.test(trimmed)) return;
        }
        const dedupeKey = `${lkey}::${trimmed}`;
        if (seenInScript.has(dedupeKey)) return;
        seenInScript.add(dedupeKey);
        addText(trimmed, `spa-json:${lkey || 'value'}`, spaJsonMatch.index);
      } else if (Array.isArray(node)) {
        for (const item of node) visitSpa(item, parentKey, depth + 1);
      } else if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) visitSpa(v, k, depth + 1);
      }
    }
    visitSpa(parsed, '', 0);
  }

  // 11. stringhe letterali negli <script> non-JSON (loose, last-resort)
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const content = scriptMatch[1];
    // Skip se contiene una marker tipico SPA: gia' coperto sopra
    if (/^\s*\{[\s\S]*\}\s*$/.test(content.trim())) continue;
    const stringRegex = /["']([^"']{2,200})["']/g;
    let sm;
    while ((sm = stringRegex.exec(content)) !== null) {
      const str = sm[1];
      if (/[a-zA-Z\s]{3,}/.test(str) && !/[{}();=<>]/.test(str)) {
        addText(str, 'script:string', scriptMatch.index);
      }
    }
  }

  // 12. telefoni
  const phoneRegex = /\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g;
  let phoneMatch;
  while ((phoneMatch = phoneRegex.exec(html)) !== null) {
    if (phoneMatch[0].length >= 10) addText(phoneMatch[0], 'phone', phoneMatch.index);
  }

  return texts;
}

module.exports = { extractAllTextsUniversal };
