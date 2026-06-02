// Sanamento pagina: rimuove i tracker del competitor (pixel, tag manager,
// analytics) dall'HTML clonato PRIMA del download. Gira lato browser (usa
// DOMParser), agisce solo sul file scaricato e NON tocca gli script
// funzionali (Swiper/caroselli, accordion FAQ, sticky bar, ecc.).

export type StripResult = {
  html: string;
  removedCount: number;
  categories: string[];
};

// Domini/URL di tracker noti — match su src/href/iframe/img. Match preciso:
// nessun falso positivo sugli asset funzionali della pagina.
const TRACKER_HOST_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /googletagmanager\.com/i, label: 'Google Tag Manager' },
  { re: /google-analytics\.com/i, label: 'Google Analytics' },
  { re: /analytics\.google\.com/i, label: 'Google Analytics' },
  { re: /gtag\/js/i, label: 'Google gtag' },
  { re: /googleadservices\.com/i, label: 'Google Ads' },
  { re: /googlesyndication\.com/i, label: 'Google Ads' },
  { re: /doubleclick\.net/i, label: 'Google DoubleClick' },
  { re: /connect\.facebook\.net/i, label: 'Meta Pixel' },
  { re: /facebook\.com\/tr/i, label: 'Meta Pixel' },
  { re: /analytics\.tiktok\.com/i, label: 'TikTok Pixel' },
  { re: /(static\.hotjar\.com|script\.hotjar\.com|hotjar\.com)/i, label: 'Hotjar' },
  { re: /clarity\.ms/i, label: 'Microsoft Clarity' },
  { re: /(cdn\.segment\.com|segment\.io)/i, label: 'Segment' },
  { re: /(cdn\.mxpnl\.com|mixpanel\.com)/i, label: 'Mixpanel' },
  { re: /amplitude\.com/i, label: 'Amplitude' },
  { re: /(ct\.pinterest\.com|pinimg\.com\/ct|s\.pinimg\.com)/i, label: 'Pinterest Tag' },
  { re: /(sc-static\.net|tr\.snapchat\.com)/i, label: 'Snapchat Pixel' },
  { re: /(static\.ads-twitter\.com|analytics\.twitter\.com|t\.co\/i\/adsct)/i, label: 'X/Twitter Pixel' },
  { re: /(snap\.licdn\.com|px\.ads\.linkedin\.com)/i, label: 'LinkedIn Insight' },
  { re: /bat\.bing\.com/i, label: 'Microsoft/Bing UET' },
  { re: /(quantserve\.com|scorecardresearch\.com)/i, label: 'Analytics' },
];

// Firme per gli <script> INLINE (modalità conservativa): rimuoviamo l'inline
// SOLO se contiene il bootstrap chiaro di un tracker. Gli script con logica
// di pagina (slider/accordion/ecc.) non matchano e restano intatti.
const INLINE_SIGNATURES: Array<{ re: RegExp; label: string }> = [
  { re: /\bfbq\s*\(/i, label: 'Meta Pixel' },
  { re: /connect\.facebook\.net/i, label: 'Meta Pixel' },
  { re: /\bgtag\s*\(/i, label: 'Google gtag' },
  { re: /googletagmanager\.com\/gtm\.js/i, label: 'Google Tag Manager' },
  { re: /www\.google-analytics\.com\/analytics\.js/i, label: 'Google Analytics' },
  { re: /\bga\s*\(\s*['"]create['"]/i, label: 'Google Analytics' },
  { re: /analytics\.tiktok\.com/i, label: 'TikTok Pixel' },
  { re: /\bttq\s*\.\s*(load|page|track)\s*\(/i, label: 'TikTok Pixel' },
  { re: /\bhj\s*\(|static\.hotjar\.com/i, label: 'Hotjar' },
  { re: /clarity\.ms|window\.clarity|\(c,l,a,r,i,t,y\)/i, label: 'Microsoft Clarity' },
  { re: /\bpintrk\s*\(/i, label: 'Pinterest Tag' },
  { re: /\bsnaptr\s*\(/i, label: 'Snapchat Pixel' },
  { re: /\btwq\s*\(/i, label: 'X/Twitter Pixel' },
  { re: /_linkedin_partner_id/i, label: 'LinkedIn Insight' },
  { re: /\buetq\b|bat\.bing\.com/i, label: 'Microsoft/Bing UET' },
];

function hostMatch(url: string | null | undefined): string | null {
  if (!url) return null;
  for (const p of TRACKER_HOST_PATTERNS) if (p.re.test(url)) return p.label;
  return null;
}

/**
 * Rimuove i tracker competitor dall'HTML. Ritorna l'HTML pulito, il numero di
 * nodi rimossi e l'elenco (deduplicato) delle categorie di tracker trovate.
 * Se non c'è nulla da rimuovere ritorna l'HTML originale invariato.
 */
export function stripCompetitorTracking(rawHtml: string): StripResult {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return { html: rawHtml || '', removedCount: 0, categories: [] };
  }
  // DOMParser esiste solo nel browser: questa util viene chiamata on-click
  // lato client. In SSR ritorniamo l'HTML invariato (no-op sicuro).
  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') {
    return { html: rawHtml, removedCount: 0, categories: [] };
  }

  let doc: Document;
  try {
    doc = new window.DOMParser().parseFromString(rawHtml, 'text/html');
  } catch {
    return { html: rawHtml, removedCount: 0, categories: [] };
  }
  if (!doc || !doc.documentElement) {
    return { html: rawHtml, removedCount: 0, categories: [] };
  }

  let removed = 0;
  const cats = new Set<string>();
  const kill = (node: Element, label: string) => {
    cats.add(label);
    removed++;
    if (node.parentNode) node.parentNode.removeChild(node);
  };

  // <script src=...> di tracker
  doc.querySelectorAll('script[src]').forEach((s) => {
    const label = hostMatch(s.getAttribute('src'));
    if (label) kill(s, label);
  });

  // <script> inline con firma tracker (conservativo)
  doc.querySelectorAll('script:not([src])').forEach((s) => {
    const code = s.textContent || '';
    if (!code.trim()) return;
    for (const sig of INLINE_SIGNATURES) {
      if (sig.re.test(code)) {
        kill(s, sig.label);
        return;
      }
    }
  });

  // <iframe src=...> (es. noscript GTM)
  doc.querySelectorAll('iframe[src]').forEach((f) => {
    const label = hostMatch(f.getAttribute('src'));
    if (label) kill(f, label);
  });

  // <img src=...> pixel di tracking
  doc.querySelectorAll('img[src]').forEach((img) => {
    const label = hostMatch(img.getAttribute('src'));
    if (label) kill(img, label);
  });

  // <link rel="preconnect|dns-prefetch|preload|prefetch"> verso tracker
  doc.querySelectorAll('link[href]').forEach((l) => {
    const rel = (l.getAttribute('rel') || '').toLowerCase();
    if (/(preconnect|dns-prefetch|preload|prefetch)/.test(rel)) {
      const label = hostMatch(l.getAttribute('href'));
      if (label) kill(l, label);
    }
  });

  // <noscript> che incapsula un pixel tracker (fb tr / GTM iframe / ecc.)
  doc.querySelectorAll('noscript').forEach((ns) => {
    const inner = ns.innerHTML || '';
    const label = hostMatch(inner);
    if (label) kill(ns, label);
  });

  if (removed === 0) {
    return { html: rawHtml, removedCount: 0, categories: [] };
  }

  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : '<!DOCTYPE html>\n';
  const html = doctype + doc.documentElement.outerHTML;
  return { html, removedCount: removed, categories: Array.from(cats) };
}
