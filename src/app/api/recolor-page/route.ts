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
 *  rgb()/rgba(), e named colors. NON supporta hsl()/hsla() o color() perché
 *  raramente compaiono in landing pages — eventualmente da estendere. */
function parseColor(raw: string): { r: number; g: number; b: number; a: number } | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'inherit' || s === 'currentcolor' || s === 'initial' || s === 'unset') {
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

  return null;
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

/** Rileva il tema della pagina originale guardando i colori non-saturati
 *  più frequenti. Se la luminanza media pesata è < 0.5 la pagina è dark
 *  themed (background scuro, testo chiaro); altrimenti light themed. */
function detectOriginalTheme(allColors: ColorOccurrence[]): 'dark' | 'light' {
  let totalWeight = 0;
  let weightedL = 0;
  for (const c of allColors) {
    // Pesa più i colori non-saturati (sono quelli di bg/testo, non gli accenti)
    const w = c.count * (1 - c.s * 0.7);
    weightedL += c.l * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return 'dark';
  const avgL = weightedL / totalWeight;
  return avgL < 0.5 ? 'dark' : 'light';
}

/** Sceglie il role della palette per un colore osservato.
 *
 *  Regole:
 *  - Colori non-saturati (s < 0.2): mappati a bg o text in base al tema.
 *    Se il tema originale e nuovo COINCIDONO → mantieni la posizione
 *    luminanza (dark→dark, light→light). Se sono OPPOSTI → swap, cioè
 *    il colore "background" originale (dark in pagina dark) prende il
 *    nuovo background (anche se light) e viceversa per il testo.
 *  - Colori saturati: scegli tra primary/secondary/accent per distanza
 *    pesata in HSL (hue conta di più, poi sat, poi luminanza). */
function pickRole(
  c: { h: number; s: number; l: number },
  palette: RoleColor[],
  originalTheme: 'dark' | 'light',
  newTheme: 'dark' | 'light',
): RoleColor {
  const pBg = palette.find(p => p.role === 'background');
  const pTxt = palette.find(p => p.role === 'text');

  // Soglia un po' più permissiva (0.2) per intercettare anche i grigi
  // medi che le landing usano come bg di sezione.
  if (c.s < 0.22 || c.l < 0.08 || c.l > 0.92) {
    if (pBg && pTxt) {
      // RELATIVE luminance check: il colore è "scuro" o "chiaro" RISPETTO
      // al tema originale?
      // - tema originale dark: i colori scuri sono background, i chiari sono testo
      // - tema originale light: i colori chiari sono background, i scuri sono testo
      const isOriginallyBackground =
        originalTheme === 'dark' ? c.l < 0.5 : c.l > 0.5;

      if (originalTheme === newTheme) {
        // Stesso tema: il bg originale prende il nuovo bg (assomigliano in L)
        return isOriginallyBackground ? pBg : pTxt;
      }
      // SWAP TEMA: il bg originale prende comunque il nuovo bg (anche se
      // L opposta). È esattamente questo che fa cambiare visivamente la
      // pagina quando l'utente applica una palette di tema opposto.
      return isOriginallyBackground ? pBg : pTxt;
    }
    return pBg || pTxt || palette[0];
  }

  // Tra i 3 colorati: distanza pesata in HSL (hue domina).
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

interface ColorOccurrence {
  token: string;
  r: number;
  g: number;
  b: number;
  a: number;
  h: number;
  s: number;
  l: number;
  count: number;
}

const COLOR_TOKEN_RE = /(#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})\b|rgba?\([^)]+\))/g;

function collectAllColors(html: string): { occurrences: ColorOccurrence[]; namedMatches: number } {
  const map = new Map<string, ColorOccurrence>();
  let m: RegExpExecArray | null;
  COLOR_TOKEN_RE.lastIndex = 0;
  while ((m = COLOR_TOKEN_RE.exec(html)) !== null) {
    const token = m[1];
    const parsed = parseColor(token);
    if (!parsed) continue;
    const hsl = rgbToHsl(parsed.r, parsed.g, parsed.b);
    const key = `${parsed.r}-${parsed.g}-${parsed.b}-${parsed.a}`;
    const prev = map.get(key);
    if (prev) {
      prev.count++;
    } else {
      map.set(key, {
        token,
        r: parsed.r, g: parsed.g, b: parsed.b, a: parsed.a,
        h: hsl.h, s: hsl.s, l: hsl.l,
        count: 1,
      });
    }
  }
  // Named colors (solo come valore di proprietà CSS)
  let namedMatches = 0;
  const NAMED_RE = new RegExp(
    `(:\\s*)(${Object.keys(NAMED_COLORS).join('|')})(\\s*[;}!"' )])`,
    'gi',
  );
  let nm: RegExpExecArray | null;
  while ((nm = NAMED_RE.exec(html)) !== null) {
    const name = nm[2].toLowerCase();
    const hex = NAMED_COLORS[name];
    const parsed = hex ? parseColor(hex) : null;
    if (!parsed) continue;
    namedMatches++;
    const hsl = rgbToHsl(parsed.r, parsed.g, parsed.b);
    const key = `${parsed.r}-${parsed.g}-${parsed.b}-${parsed.a}`;
    const prev = map.get(key);
    if (prev) {
      prev.count++;
    } else {
      map.set(key, {
        token: name,
        r: parsed.r, g: parsed.g, b: parsed.b, a: parsed.a,
        h: hsl.h, s: hsl.s, l: hsl.l,
        count: 1,
      });
    }
  }
  return { occurrences: [...map.values()], namedMatches };
}

/** Trova tutti i token colore nell'HTML, fa un first-pass per rilevare il
 *  tema dominante della pagina, poi sostituisce ogni token con il role
 *  palette più appropriato (vedi pickRole). */
function recolor(html: string, paletteColors: RoleColor[]): {
  html: string;
  replacements: number;
  originalTheme: 'dark' | 'light';
  newTheme: 'dark' | 'light';
} {
  // Tema della nuova palette: confronta L di background e text
  const pBg = paletteColors.find(p => p.role === 'background');
  const pTxt = paletteColors.find(p => p.role === 'text');
  const newTheme: 'dark' | 'light' =
    pBg && pTxt ? (pBg.l > pTxt.l ? 'light' : 'dark')
    : pBg ? (pBg.l > 0.5 ? 'light' : 'dark')
    : 'dark';

  // First pass: scan colori + tema originale
  const { occurrences } = collectAllColors(html);
  const originalTheme = detectOriginalTheme(occurrences);

  let replacements = 0;

  // Sostituzione hex / rgb / rgba
  let out = html.replace(COLOR_TOKEN_RE, (token) => {
    const parsed = parseColor(token);
    if (!parsed) return token;
    const hsl = rgbToHsl(parsed.r, parsed.g, parsed.b);
    const role = pickRole(hsl, paletteColors, originalTheme, newTheme);
    replacements++;
    return formatRgba(role.r, role.g, role.b, parsed.a);
  });

  // Sostituzione named colors (solo come valore CSS)
  const NAMED_RE = new RegExp(
    `(:\\s*)(${Object.keys(NAMED_COLORS).join('|')})(\\s*[;}!"' )])`,
    'gi',
  );
  out = out.replace(NAMED_RE, (m, prefix, name, suffix) => {
    const hex = NAMED_COLORS[name.toLowerCase()];
    const parsed = hex ? parseColor(hex) : null;
    if (!parsed) return m;
    const hsl = rgbToHsl(parsed.r, parsed.g, parsed.b);
    const role = pickRole(hsl, paletteColors, originalTheme, newTheme);
    replacements++;
    return `${prefix}${rgbToHex({ r: role.r, g: role.g, b: role.b })}${suffix}`;
  });

  return { html: out, replacements, originalTheme, newTheme };
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

    const { html: out, replacements, originalTheme, newTheme } = recolor(html, paletteColors);

    return NextResponse.json({
      ok: true,
      html: out,
      replacements,
      originalLength: html.length,
      newLength: out.length,
      originalTheme,
      newTheme,
      themeSwapped: originalTheme !== newTheme,
    });
  } catch (error) {
    console.error('[api/recolor-page] Error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
