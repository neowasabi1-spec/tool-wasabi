/**
 * Infer geo from PAGE LANGUAGE only — never from the URL.
 * Almost every advertorial is on a random .com, so TLD/path would be fake.
 * German copy → DE, Italian → IT, English → EN, etc.
 */

export type PageGeo = {
  geo: string;
  lang: string;
};

const GEO_ORDER = [
  'EN', 'DE', 'IT', 'FR', 'ES', 'PT', 'NL', 'PL', 'SV', 'DA', 'NO', 'FI',
  'CS', 'RO', 'HU', 'EL', 'TR', 'JA',
] as const;

/** ISO 639-1 → filter code (same letters, uppercased). */
const LANG_GEO: Record<string, string> = {
  en: 'EN',
  de: 'DE',
  it: 'IT',
  fr: 'FR',
  es: 'ES',
  nl: 'NL',
  pl: 'PL',
  pt: 'PT',
  sv: 'SV',
  da: 'DA',
  nb: 'NO',
  nn: 'NO',
  no: 'NO',
  fi: 'FI',
  cs: 'CS',
  ro: 'RO',
  hu: 'HU',
  el: 'EL',
  tr: 'TR',
  ja: 'JA',
  ko: 'KO',
  uk: 'UA',
};

/** Language → a country flag that *represents that language* (not the market). */
const LANG_FLAG: Record<string, string> = {
  EN: 'GB',
  DE: 'DE',
  IT: 'IT',
  FR: 'FR',
  ES: 'ES',
  PT: 'PT',
  NL: 'NL',
  PL: 'PL',
  SV: 'SE',
  DA: 'DK',
  NO: 'NO',
  FI: 'FI',
  CS: 'CZ',
  RO: 'RO',
  HU: 'HU',
  EL: 'GR',
  TR: 'TR',
  JA: 'JP',
  KO: 'KR',
  UA: 'UA',
};

const SEARCH_ALIASES: Record<string, string[]> = {
  EN: ['en', 'english', 'inglese', 'eng'],
  DE: ['de', 'german', 'deutsch', 'tedesco', 'germany', 'deutschland'],
  IT: ['it', 'italian', 'italiano', 'italy', 'italia'],
  FR: ['fr', 'french', 'francese', 'france', 'francia'],
  ES: ['es', 'spanish', 'spagnolo', 'spain', 'spagna', 'espanol', 'español'],
  PT: ['pt', 'portuguese', 'portoghese', 'portugal'],
  NL: ['nl', 'dutch', 'olandese', 'netherlands'],
  PL: ['pl', 'polish', 'polacco', 'poland', 'polonia'],
  SV: ['sv', 'swedish', 'svedese', 'sweden'],
  DA: ['da', 'danish', 'danese', 'denmark'],
  NO: ['no', 'norwegian', 'norvegese', 'norway'],
  FI: ['fi', 'finnish', 'finlandese', 'finland'],
  CS: ['cs', 'czech', 'ceco'],
  RO: ['ro', 'romanian', 'rumeno', 'romania'],
  HU: ['hu', 'hungarian', 'ungherese'],
  EL: ['el', 'greek', 'greco', 'greece'],
  TR: ['tr', 'turkish', 'turco', 'turkey'],
  JA: ['ja', 'japanese', 'giapponese', 'japan'],
};

const LANG_MARKERS: { lang: string; words: string[] }[] = [
  { lang: 'de', words: ['nicht', 'und', 'eine', 'einen', 'werden', 'können', 'auch', 'nach', 'über', 'sich', 'ich', 'sie', 'mit', 'auf', 'für', 'dass', 'oder', 'aber', 'wenn', 'haben', 'diese', 'einem', 'ihre', 'jetzt'] },
  { lang: 'it', words: ['che', 'non', 'per', 'una', 'sono', 'della', 'più', 'come', 'anche', 'questo', 'tutti', 'nella', 'degli', 'perché', 'essere', 'quando', 'dopo', 'molto', 'senza', 'ancora', 'quella'] },
  { lang: 'fr', words: ['les', 'une', 'des', 'pour', 'dans', 'que', 'est', 'pas', 'plus', 'vous', 'avec', 'cette', 'sont', 'mais', 'tout', 'fait', 'comme'] },
  { lang: 'es', words: ['que', 'los', 'las', 'una', 'con', 'para', 'por', 'más', 'este', 'esta', 'como', 'pero', 'todo', 'está', 'cuando'] },
  { lang: 'pt', words: ['não', 'para', 'uma', 'com', 'mais', 'você', 'está', 'como', 'mas', 'pela', 'pelo', 'também', 'quando'] },
  { lang: 'nl', words: ['het', 'een', 'van', 'niet', 'voor', 'met', 'zijn', 'dat', 'ook', 'deze', 'maar', 'als', 'naar'] },
  { lang: 'pl', words: ['nie', 'się', 'jest', 'dla', 'jak', 'czy', 'oraz', 'tylko', 'przez', 'może', 'tego'] },
  { lang: 'en', words: ['the', 'and', 'you', 'that', 'with', 'this', 'your', 'from', 'have', 'will', 'what', 'about', 'they', 'their'] },
];

export function normalizeGeo(raw: string): string {
  const t = String(raw || '').trim().toUpperCase();
  if (t === 'GB') return 'EN';
  if (t === 'US' || t === 'UK' || t === 'AU' || t === 'CA' || t === 'IE' || t === 'NZ') return 'EN';
  if (t === 'AT' || t === 'CH') return 'DE';
  if (t === 'BR' || t === 'MX') return t === 'BR' ? 'PT' : 'ES';
  if (t === 'SE') return 'SV';
  if (t === 'DK') return 'DA';
  if (t === 'GR') return 'EL';
  if (t === 'JP') return 'JA';
  if (t === 'CZ') return 'CS';
  if (/^[A-Z]{2}$/.test(t)) return t;
  return '';
}

function regionalFlag(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0)));
}

export function flagEmoji(geo: string): string {
  const g = normalizeGeo(geo);
  // English is a language, not a country — don't stamp 🇺🇸/🇬🇧 on .com pages.
  if (!g || g === 'EN') return '';
  const cc = LANG_FLAG[g] || g;
  return regionalFlag(cc);
}

export function geoLabel(geo: string): string {
  const g = normalizeGeo(geo);
  if (!g) return '';
  const flag = flagEmoji(g);
  return flag ? `${flag} ${g}` : g;
}

export function sortGeos(codes: string[]): string[] {
  return [...new Set(codes.map(normalizeGeo).filter(Boolean))].sort((a, b) => {
    const ia = (GEO_ORDER as readonly string[]).indexOf(a);
    const ib = (GEO_ORDER as readonly string[]).indexOf(b);
    if (ia < 0 && ib < 0) return a.localeCompare(b);
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });
}

export function geoMatchesSearch(geo: string | undefined, q: string): boolean {
  const g = normalizeGeo(geo || '');
  if (!g || !q) return false;
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  if (g.toLowerCase() === needle) return true;
  if (flagEmoji(g) === q.trim()) return true;
  return (SEARCH_ALIASES[g] || []).some((a) => a === needle || a.startsWith(needle));
}

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16000);
}

function htmlLang(html: string): string {
  const raw = String(html || '');
  const attrs = [
    raw.match(/<html[^>]*\slang=["']([^"']+)["']/i)?.[1],
    raw.match(/<html[^>]*\sxml:lang=["']([^"']+)["']/i)?.[1],
    raw.match(/property=["']og:locale["'][^>]*content=["']([^"']+)["']/i)?.[1],
    raw.match(/content=["']([^"']+)["'][^>]*property=["']og:locale["']/i)?.[1],
    raw.match(/http-equiv=["']content-language["'][^>]*content=["']([^"']+)["']/i)?.[1],
  ];
  return String(attrs.find(Boolean) || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
}

function langFromTag(tag: string): string {
  const t = tag.trim().toLowerCase().replace(/_/g, '-');
  if (!t) return '';
  const lang = t.slice(0, 2);
  return LANG_GEO[lang] ? lang : '';
}

function scoreLang(text: string): string {
  const hay = ` ${text.toLowerCase().replace(/[^a-zàèéìòùäöüßáéíóúãõçñ\s]/gi, ' ')} `;
  if (!hay.trim()) return '';
  let best = '';
  let bestN = 0;
  for (const row of LANG_MARKERS) {
    let n = 0;
    for (const w of row.words) {
      if (hay.includes(` ${w} `)) n++;
    }
    if (n > bestN) {
      bestN = n;
      best = row.lang;
    }
  }
  if (bestN < 4) {
    if (/[äöüß]/.test(hay)) return 'de';
    if (/[àèéìòù]/.test(hay) && (hay.includes(' che ') || hay.includes(' della '))) return 'it';
    return '';
  }
  return best;
}

export function inferPageGeo(opts: { url?: string; html?: string; title?: string }): PageGeo {
  const html = String(opts.html || '');
  const title = String(opts.title || '');
  const text = `${title} ${title} ${stripHtml(html)}`;

  const fromAttr = langFromTag(htmlLang(html));
  const scored = scoreLang(text);
  // Prefer the actual copy when html lang is missing or a generic "en" default
  // on a German/Italian advertorial (very common on page builders).
  let lang = scored;
  if (!lang) lang = fromAttr;
  else if (fromAttr && fromAttr !== 'en' && scored === 'en' && fromAttr !== scored) lang = fromAttr;
  else if (fromAttr && scored && fromAttr === scored) lang = scored;

  const geo = LANG_GEO[lang] || '';
  return { geo, lang };
}

/** Prefer a stored geo; otherwise infer from page HTML/title language. */
export function resolvePageGeo(opts: {
  geo?: unknown;
  url?: string;
  html?: string;
  title?: string;
}): string {
  const stored = normalizeGeo(String(opts.geo || ''));
  if (stored) return stored;
  return inferPageGeo({
    html: typeof opts.html === 'string' ? opts.html.slice(0, 20000) : '',
    title: opts.title,
  }).geo;
}
