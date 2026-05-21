import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/**
 * POST /api/recolor-page
 *
 * Ricolora deterministicamente l'intera pagina HTML usando una palette
 * di 5 colori (primary / secondary / accent / background / text).
 *
 * Perché NON usiamo un LLM qui:
 * - /api/ai-edit-html con Claude/Gemini su pagine grandi (100-500 KB) genera
 *   8-40 chunk e ogni chunk costa 10-30s → totale 80-1200s, ben oltre i 300s
 *   di timeout Netlify. Il client vede "network error" perché la function
 *   muore mid-stream.
 * - Il task "ricolora" è in realtà deterministico: per ogni colore presente
 *   (hex / rgb / rgba / named) scegliamo il ruolo della palette più vicino
 *   in spazio HSL e facciamo lo swap. Risultato consistente, niente API
 *   esterne, niente timeout.
 *
 * Body:
 *   { html: string, palette: { primary, secondary, accent, background, text } }
 *
 * Response:
 *   { ok: true, html: string, replacements: number }
 */

interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
}

type Role = keyof Palette;

interface Body {
  html: string;
  palette: Palette;
}

/* ──────────────────────── color parsing ──────────────────────── */

/** named CSS colors → hex (subset frequente nelle landing) */
const NAMED_COLORS: Record<string, string> = {
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4',
  azure: '#f0ffff', beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000',
  blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a',
  burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e',
  coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
  cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', darkgreen: '#006400', darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b', darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc',
  darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', darkturquoise: '#00ced1', darkviolet: '#9400d3',
  deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969',
  dodgerblue: '#1e90ff', firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22',
  fuchsia: '#ff00ff', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff', gold: '#ffd700',
  goldenrod: '#daa520', gray: '#808080', grey: '#808080', green: '#008000',
  greenyellow: '#adff2f', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
  indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa',
  lavenderblush: '#fff0f5', lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6',
  lightcoral: '#f08080', lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3', lightgreen: '#90ee90', lightpink: '#ffb6c1', lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
  lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32',
  linen: '#faf0e6', magenta: '#ff00ff', maroon: '#800000', mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd', mediumorchid: '#ba55d3', mediumpurple: '#9370db', mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc', mediumvioletred: '#c71585',
  midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5',
  navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000',
  olivedrab: '#6b8e23', orange: '#ffa500', orangered: '#ff4500', orchid: '#da70d6',
  palegoldenrod: '#eee8aa', palegreen: '#98fb98', paleturquoise: '#afeeee', palevioletred: '#db7093',
  papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f', pink: '#ffc0cb',
  plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399',
  red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1', saddlebrown: '#8b4513',
  salmon: '#fa8072', sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee',
  sienna: '#a0522d', silver: '#c0c0c0', skyblue: '#87ceeb', slateblue: '#6a5acd',
  slategray: '#708090', slategrey: '#708090', snow: '#fffafa', springgreen: '#00ff7f',
  steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8',
  tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3',
  white: '#ffffff', whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32',
};

/** Parsa qualunque colore CSS in [r, g, b] 0-255 + alpha 0-1.
 *  Ritorna null se non riconosciuto. Supporta hex (#fff, #ffffff, #ffffffff),
 *  rgb()/rgba(), hsl()/hsla(), e named colors. */
function parseColor(raw: string): { r: number; g: number; b: number; a: number } | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'inherit' || s === 'currentcolor' || s === 'initial' || s === 'unset' || s === 'none') {
    return null;
  }

  // named
  if (NAMED_COLORS[s]) {
    return parseColor(NAMED_COLORS[s]);
  }

  // hex
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) {
      hex = hex.split('').map(c => c + c).join('');
    } else if (hex.length === 4) {
      hex = hex.split('').map(c => c + c).join('');
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return { r, g, b, a: 1 };
      }
    }
    if (hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = parseInt(hex.slice(6, 8), 16) / 255;
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return { r, g, b, a };
      }
    }
    return null;
  }

  // rgb / rgba
  const rgbMatch = s.match(/^rgba?\(\s*([^)]+)\)$/);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[,\s/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const r = parsePercentOrInt(parts[0]);
      const g = parsePercentOrInt(parts[1]);
      const b = parsePercentOrInt(parts[2]);
      const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
      if (r !== null && g !== null && b !== null) {
        return { r, g, b, a };
      }
    }
  }

  // hsl / hsla
  const hslMatch = s.match(/^hsla?\(\s*([^)]+)\)$/);
  if (hslMatch) {
    const parts = hslMatch[1].split(/[,\s/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const h = parseHueDeg(parts[0]);
      const sat = parsePercent01(parts[1]);
      const lig = parsePercent01(parts[2]);
      const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
      if (h !== null && sat !== null && lig !== null) {
        const { r, g, b } = hslToRgb(h, sat, lig);
        return { r, g, b, a };
      }
    }
  }

  return null;
}

function parseHueDeg(s: string): number | null {
  const t = s.trim().replace(/deg$/i, '').replace(/turn$/i, '');
  // Possibili unità: deg (default), rad, grad, turn
  if (s.trim().endsWith('rad')) {
    const v = parseFloat(s.trim().replace(/rad$/i, ''));
    return Number.isFinite(v) ? (v * 180) / Math.PI : null;
  }
  if (s.trim().endsWith('grad')) {
    const v = parseFloat(s.trim().replace(/grad$/i, ''));
    return Number.isFinite(v) ? (v * 360) / 400 : null;
  }
  if (s.trim().endsWith('turn')) {
    const v = parseFloat(s.trim().replace(/turn$/i, ''));
    return Number.isFinite(v) ? v * 360 : null;
  }
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

function parsePercent01(s: string): number | null {
  const t = s.trim();
  if (t.endsWith('%')) {
    const v = parseFloat(t.slice(0, -1));
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : null;
  }
  const v = parseFloat(t);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hh = ((h % 360) + 360) % 360 / 360;
  const f = (n: number, k = (n + hh * 12) % 12) =>
    l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  };
}

function parsePercentOrInt(s: string): number | null {
  const t = s.trim();
  if (t.endsWith('%')) {
    const v = parseFloat(t.slice(0, -1));
    if (!Number.isFinite(v)) return null;
    return Math.round((v / 100) * 255);
  }
  const v = parseFloat(t);
  if (!Number.isFinite(v)) return null;
  return Math.round(Math.max(0, Math.min(255, v)));
}

function parseAlpha(s: string): number {
  const t = s.trim();
  if (t.endsWith('%')) {
    const v = parseFloat(t.slice(0, -1));
    return Number.isFinite(v) ? v / 100 : 1;
  }
  const v = parseFloat(t);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rN: h = ((gN - bN) / d + (gN < bN ? 6 : 0)); break;
      case gN: h = ((bN - rN) / d + 2); break;
      case bN: h = ((rN - gN) / d + 4); break;
    }
    h *= 60;
  }
  return { h, s, l };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function formatRgba(r: number, g: number, b: number, a: number): string {
  if (a >= 1) return rgbToHex({ r, g, b });
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/* ──────────────────────── role assignment ──────────────────────── */

interface RoleColor {
  role: Role;
  h: number;
  s: number;
  l: number;
  r: number;
  g: number;
  b: number;
}

function buildPaletteColors(palette: Palette): RoleColor[] {
  const out: RoleColor[] = [];
  for (const role of ['primary', 'secondary', 'accent', 'background', 'text'] as Role[]) {
    const parsed = parseColor(palette[role]);
    if (!parsed) continue;
    const hsl = rgbToHsl(parsed.r, parsed.g, parsed.b);
    out.push({ role, h: hsl.h, s: hsl.s, l: hsl.l, r: parsed.r, g: parsed.g, b: parsed.b });
  }
  return out;
}

/** Rileva il tema della pagina originale in modo CONTEXT-AWARE: distingue
 *  i colori usati come `background:` da quelli usati come `color:` (testo).
 *  È molto più affidabile di una media luminanza globale, perché in una
 *  landing dark-themed i grigi chiari del testo (#ccc, #ddd, #fff) appaiono
 *  più volte dei pochi bg neri e sviano una media non-pesata.
 *
 *  Logica:
 *  1) Conta quante volte appare un colore SCURO non-saturato come background
 *     vs un colore CHIARO. Più background scuri → tema dark.
 *  2) Se i background sono empty/ambigui → guarda i text colors: più testo
 *     chiaro = tema dark (perché il testo chiaro presuppone bg scuro). */
function detectOriginalTheme(html: string): 'dark' | 'light' {
  const COLOR_VALUE_RE = /(#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})\b|rgba?\([^)]+\))/;
  const NAMED_OR_COLOR = `(?:${COLOR_VALUE_RE.source}|${Object.keys(NAMED_COLORS).join('|')})`;

  // background: <color>  oppure  background-color: <color>
  // oppure: background: ... linear-gradient(..., <color>, <color>) — beccato
  // dal parser di token sotto in pratica.
  const bgRe = new RegExp(
    `background(?:-color)?\\s*:\\s*([^;"'}]+)`,
    'gi',
  );
  // color: <color>   (ma NON background-color)
  const textRe = new RegExp(
    `(?:^|[^-])\\bcolor\\s*:\\s*([^;"'}]+)`,
    'gi',
  );

  const score = { darkBg: 0, lightBg: 0, darkText: 0, lightText: 0 };

  const scoreColorValue = (raw: string, bucket: 'bg' | 'text') => {
    // Possono esserci più token colore in un singolo value (es. gradient)
    const tokenRe = new RegExp(NAMED_OR_COLOR, 'gi');
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(raw)) !== null) {
      const tok = m[0];
      const parsed = parseColor(tok);
      if (!parsed) continue;
      const hsl = rgbToHsl(parsed.r, parsed.g, parsed.b);
      // skip saturati (CTA / accenti) — non aiutano a definire il tema
      if (hsl.s > 0.35) continue;
      if (bucket === 'bg') {
        if (hsl.l < 0.5) score.darkBg++;
        else score.lightBg++;
      } else {
        if (hsl.l < 0.5) score.darkText++;
        else score.lightText++;
      }
    }
  };

  let m: RegExpExecArray | null;
  bgRe.lastIndex = 0;
  while ((m = bgRe.exec(html)) !== null) scoreColorValue(m[1], 'bg');
  textRe.lastIndex = 0;
  while ((m = textRe.exec(html)) !== null) scoreColorValue(m[1], 'text');

  // Decision tree
  if (score.darkBg > score.lightBg && score.darkBg >= 2) return 'dark';
  if (score.lightBg > score.darkBg && score.lightBg >= 2) return 'light';

  // Fallback al testo: tanto testo chiaro = tema dark (presuppone bg dark)
  if (score.lightText > score.darkText * 1.5) return 'dark';
  if (score.darkText > score.lightText * 1.5) return 'light';

  // Default conservativo: dark (più comune nelle landing converting)
  return 'dark';
}

/** Trova il colore dominante usato come PAGE BACKGROUND (su <html>, <body>
 *  o sui selettori `html {}` / `body {}` dentro <style>). Usato per
 *  force-mappare quel colore (e tutti i suoi "vicini") al nuovo background,
 *  garantendo che il bg della pagina cambi sempre. */
function detectPageBackground(html: string): { r: number; g: number; b: number } | null {
  const candidates: string[] = [];

  // 1) <body style="... background: X ...">
  const bodyStyleMatch = html.match(/<body[^>]*\sstyle\s*=\s*["']([^"']+)["']/i);
  if (bodyStyleMatch) {
    const m = bodyStyleMatch[1].match(/background(?:-color)?\s*:\s*([^;]+)/i);
    if (m) candidates.push(m[1]);
  }
  // 2) <html style="... background: X ...">
  const htmlStyleMatch = html.match(/<html[^>]*\sstyle\s*=\s*["']([^"']+)["']/i);
  if (htmlStyleMatch) {
    const m = htmlStyleMatch[1].match(/background(?:-color)?\s*:\s*([^;]+)/i);
    if (m) candidates.push(m[1]);
  }
  // 3) <body bgcolor="X">
  const bgAttr = html.match(/<body[^>]*\sbgcolor\s*=\s*["']?([^"'>\s]+)/i);
  if (bgAttr) candidates.push(bgAttr[1]);
  // 4) `body { background: X }` dentro <style>
  const bodySelectorMatch = html.match(/(?:^|[\s,}])body\s*\{[^}]*background(?:-color)?\s*:\s*([^;}]+)/i);
  if (bodySelectorMatch) candidates.push(bodySelectorMatch[1]);
  // 5) `html { background: X }`
  const htmlSelectorMatch = html.match(/(?:^|[\s,}])html\s*\{[^}]*background(?:-color)?\s*:\s*([^;}]+)/i);
  if (htmlSelectorMatch) candidates.push(htmlSelectorMatch[1]);
  // 6) `:root { background: X }`
  const rootSelectorMatch = html.match(/:root\s*\{[^}]*background(?:-color)?\s*:\s*([^;}]+)/i);
  if (rootSelectorMatch) candidates.push(rootSelectorMatch[1]);

  // Estrai il PRIMO token colore valido da ciascun candidato (gradient,
  // valore semplice, ecc.) e ritorna il primo che si parsa correttamente.
  for (const cand of candidates) {
    const tokenRe = /(#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})\b|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-z]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(cand)) !== null) {
      const tok = m[0];
      const parsed = parseColor(tok);
      if (parsed) return { r: parsed.r, g: parsed.g, b: parsed.b };
    }
  }
  return null;
}

function rgbDistance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  return Math.sqrt(
    Math.pow(a.r - b.r, 2) + Math.pow(a.g - b.g, 2) + Math.pow(a.b - b.b, 2),
  );
}

/** Sceglie il role della palette per un colore osservato.
 *
 *  Regole (in ordine di priorità):
 *  1) Se il colore è MOLTO vicino al page background rilevato → force map a
 *     new bg (anche se ha un po' di saturazione, tipo dark blue tinted).
 *  2) Estremi di luminanza (l < 0.18 o l > 0.88): sempre bg/text (anche
 *     se saturati — un #0a1428 navy quasi-nero è chiaramente un bg, non
 *     un primary).
 *  3) Bassa saturazione (s < 0.22): bg/text in base al tema originale.
 *  4) Saturazione media-alta: pick tra primary/secondary/accent per
 *     distanza HSL pesata. */
function pickRole(
  c: { h: number; s: number; l: number; r: number; g: number; b: number },
  palette: RoleColor[],
  originalTheme: 'dark' | 'light',
  newTheme: 'dark' | 'light',
  pageBg: { r: number; g: number; b: number } | null,
): RoleColor {
  const pBg = palette.find(p => p.role === 'background');
  const pTxt = palette.find(p => p.role === 'text');

  // 1) Force-map del page background
  if (pageBg && pBg) {
    const dist = rgbDistance(c, pageBg);
    if (dist < 30) {
      return pBg;
    }
  }

  // 2) Luminanza estrema → sempre bg/text (anche con qualche saturazione,
  //    cattura i dark blue tinted backgrounds tipo #0a1428).
  // 3) Bassa saturazione → bg/text
  const isBgTextCandidate =
    c.s < 0.22 ||
    c.l < 0.18 ||
    c.l > 0.88 ||
    (c.s < 0.45 && (c.l < 0.22 || c.l > 0.82));

  if (isBgTextCandidate) {
    if (pBg && pTxt) {
      const isOriginallyBackground =
        originalTheme === 'dark' ? c.l < 0.5 : c.l > 0.5;
      return isOriginallyBackground ? pBg : pTxt;
    }
    return pBg || pTxt || palette[0];
  }

  // 4) Tra i 3 colorati: distanza pesata in HSL (hue domina).
  const colored = palette.filter(p => p.role !== 'background' && p.role !== 'text');
  if (colored.length === 0) return palette[0];

  let best = colored[0];
  let bestD = Infinity;
  for (const p of colored) {
    let dH = Math.abs(c.h - p.h);
    if (dH > 180) dH = 360 - dH;
    const dS = Math.abs(c.s - p.s);
    const dL = Math.abs(c.l - p.l);
    const d = dH * 1.0 + dS * 100 + dL * 50;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/* ──────────────────────── replacement ──────────────────────── */

// hex (#rgb, #rrggbb, #rgba, #rrggbbaa) + rgb/rgba + hsl/hsla
const COLOR_TOKEN_RE = /(#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})\b|rgba?\([^)]+\)|hsla?\([^)]+\))/g;

/** Trova tutti i token colore nell'HTML, fa un first-pass per rilevare il
 *  tema dominante della pagina e il page background, poi sostituisce ogni
 *  token con il role palette più appropriato (vedi pickRole). */
function recolor(html: string, paletteColors: RoleColor[]): {
  html: string;
  replacements: number;
  originalTheme: 'dark' | 'light';
  newTheme: 'dark' | 'light';
  pageBgDetected: string | null;
} {
  // Tema della nuova palette: confronta L di background e text
  const pBg = paletteColors.find(p => p.role === 'background');
  const pTxt = paletteColors.find(p => p.role === 'text');
  const newTheme: 'dark' | 'light' =
    pBg && pTxt ? (pBg.l > pTxt.l ? 'light' : 'dark')
    : pBg ? (pBg.l > 0.5 ? 'light' : 'dark')
    : 'dark';

  const originalTheme = detectOriginalTheme(html);
  const pageBg = detectPageBackground(html);

  let replacements = 0;

  const mapColor = (parsed: { r: number; g: number; b: number; a: number }) => {
    const hsl = rgbToHsl(parsed.r, parsed.g, parsed.b);
    return pickRole(
      { ...hsl, r: parsed.r, g: parsed.g, b: parsed.b },
      paletteColors,
      originalTheme,
      newTheme,
      pageBg,
    );
  };

  // 1) Sostituzione hex / rgb / rgba / hsl / hsla
  let out = html.replace(COLOR_TOKEN_RE, (token) => {
    const parsed = parseColor(token);
    if (!parsed) return token;
    const role = mapColor(parsed);
    replacements++;
    return formatRgba(role.r, role.g, role.b, parsed.a);
  });

  // 2) Sostituzione named colors (solo come VALORE di proprietà CSS, non
  //    come testo libero — sennò ti cambia "white smile" nel testo).
  const NAMED_RE = new RegExp(
    `(:\\s*)(${Object.keys(NAMED_COLORS).join('|')})(\\s*[;}!"' )])`,
    'gi',
  );
  out = out.replace(NAMED_RE, (m, prefix, name, suffix) => {
    const hex = NAMED_COLORS[name.toLowerCase()];
    const parsed = hex ? parseColor(hex) : null;
    if (!parsed) return m;
    const role = mapColor(parsed);
    replacements++;
    return `${prefix}${rgbToHex({ r: role.r, g: role.g, b: role.b })}${suffix}`;
  });

  // 3) Sostituzione attributi HTML deprecati (bgcolor, color="#fff" su <font>)
  //    Sono colori da rimappare al pari del CSS.
  const ATTR_COLOR_RE = /\b(bgcolor|color)\s*=\s*(["'])([^"']+)\2/gi;
  out = out.replace(ATTR_COLOR_RE, (m, attr, quote, value) => {
    const parsed = parseColor(value);
    if (!parsed) return m;
    const role = mapColor(parsed);
    replacements++;
    return `${attr}=${quote}${rgbToHex({ r: role.r, g: role.g, b: role.b })}${quote}`;
  });

  return {
    html: out,
    replacements,
    originalTheme,
    newTheme,
    pageBgDetected: pageBg ? rgbToHex(pageBg) : null,
  };
}

/* ──────────────────────── handler ──────────────────────── */

export async function POST(request: NextRequest) {
  try {
    const body: Body = await request.json();
    const { html, palette } = body;

    if (!html || typeof html !== 'string') {
      return NextResponse.json({ ok: false, error: 'html is required' }, { status: 400 });
    }
    if (!palette || typeof palette !== 'object') {
      return NextResponse.json({ ok: false, error: 'palette is required' }, { status: 400 });
    }

    const paletteColors = buildPaletteColors(palette);
    if (paletteColors.length < 3) {
      return NextResponse.json(
        { ok: false, error: 'palette must contain at least primary, secondary and accent' },
        { status: 400 },
      );
    }

    const { html: out, replacements, originalTheme, newTheme, pageBgDetected } = recolor(html, paletteColors);

    return NextResponse.json({
      ok: true,
      html: out,
      replacements,
      originalLength: html.length,
      newLength: out.length,
      originalTheme,
      newTheme,
      themeSwapped: originalTheme !== newTheme,
      pageBgDetected,
    });
  } catch (error) {
    console.error('[api/recolor-page] Error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
