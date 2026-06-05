/**
 * Deterministic palette recolouring of an HTML page.
 *
 * Pure-TS module with NO Next.js / Node dependency, so it runs identically
 * in the browser AND in a server route. The endpoint
 * `src/app/api/recolor-page/route.ts` wraps it for backwards compat;
 * heavy clients should call `recolorPage()` directly to skip the network
 * (and Netlify's 6MB request body cap, which is the failure mode on big
 * landings where this used to error with "Server returned non-JSON
 * (HTTP 500)").
 */

export interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
}

export type Role = keyof Palette;

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

function parseColor(raw: string): { r: number; g: number; b: number; a: number } | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'inherit' || s === 'currentcolor' || s === 'initial' || s === 'unset' || s === 'none') {
    return null;
  }

  if (NAMED_COLORS[s]) return parseColor(NAMED_COLORS[s]);

  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
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

function detectOriginalTheme(html: string): 'dark' | 'light' {
  const COLOR_VALUE_RE = /(#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})\b|rgba?\([^)]+\))/;
  const NAMED_OR_COLOR = `(?:${COLOR_VALUE_RE.source}|${Object.keys(NAMED_COLORS).join('|')})`;

  const bgRe = new RegExp(`background(?:-color)?\\s*:\\s*([^;"'}]+)`, 'gi');
  const textRe = new RegExp(`(?:^|[^-])\\bcolor\\s*:\\s*([^;"'}]+)`, 'gi');

  const score = { darkBg: 0, lightBg: 0, darkText: 0, lightText: 0 };

  const scoreColorValue = (raw: string, bucket: 'bg' | 'text') => {
    const tokenRe = new RegExp(NAMED_OR_COLOR, 'gi');
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(raw)) !== null) {
      const tok = m[0];
      const parsed = parseColor(tok);
      if (!parsed) continue;
      const hsl = rgbToHsl(parsed.r, parsed.g, parsed.b);
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

  if (score.darkBg > score.lightBg && score.darkBg >= 2) return 'dark';
  if (score.lightBg > score.darkBg && score.lightBg >= 2) return 'light';
  if (score.lightText > score.darkText * 1.5) return 'dark';
  if (score.darkText > score.lightText * 1.5) return 'light';
  return 'dark';
}

function detectPageBackground(html: string): { r: number; g: number; b: number } | null {
  const candidates: string[] = [];

  const bodyStyleMatch = html.match(/<body[^>]*\sstyle\s*=\s*["']([^"']+)["']/i);
  if (bodyStyleMatch) {
    const m = bodyStyleMatch[1].match(/background(?:-color)?\s*:\s*([^;]+)/i);
    if (m) candidates.push(m[1]);
  }
  const htmlStyleMatch = html.match(/<html[^>]*\sstyle\s*=\s*["']([^"']+)["']/i);
  if (htmlStyleMatch) {
    const m = htmlStyleMatch[1].match(/background(?:-color)?\s*:\s*([^;]+)/i);
    if (m) candidates.push(m[1]);
  }
  const bgAttr = html.match(/<body[^>]*\sbgcolor\s*=\s*["']?([^"'>\s]+)/i);
  if (bgAttr) candidates.push(bgAttr[1]);
  const bodySelectorMatch = html.match(/(?:^|[\s,}])body\s*\{[^}]*background(?:-color)?\s*:\s*([^;}]+)/i);
  if (bodySelectorMatch) candidates.push(bodySelectorMatch[1]);
  const htmlSelectorMatch = html.match(/(?:^|[\s,}])html\s*\{[^}]*background(?:-color)?\s*:\s*([^;}]+)/i);
  if (htmlSelectorMatch) candidates.push(htmlSelectorMatch[1]);
  const rootSelectorMatch = html.match(/:root\s*\{[^}]*background(?:-color)?\s*:\s*([^;}]+)/i);
  if (rootSelectorMatch) candidates.push(rootSelectorMatch[1]);

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

function pickRole(
  c: { h: number; s: number; l: number; r: number; g: number; b: number },
  palette: RoleColor[],
  originalTheme: 'dark' | 'light',
  _newTheme: 'dark' | 'light',
  pageBg: { r: number; g: number; b: number } | null,
): RoleColor {
  const pBg = palette.find(p => p.role === 'background');
  const pTxt = palette.find(p => p.role === 'text');

  if (pageBg && pBg) {
    const dist = rgbDistance(c, pageBg);
    if (dist < 30) return pBg;
  }

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

const COLOR_TOKEN_RE = /(#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})\b|rgba?\([^)]+\)|hsla?\([^)]+\))/g;

export interface RecolorResult {
  html: string;
  replacements: number;
  originalLength: number;
  newLength: number;
  originalTheme: 'dark' | 'light';
  newTheme: 'dark' | 'light';
  themeSwapped: boolean;
  pageBgDetected: string | null;
}

export function recolorPage(html: string, palette: Palette): RecolorResult {
  const paletteColors = buildPaletteColors(palette);
  if (paletteColors.length < 3) {
    throw new Error('palette must contain at least primary, secondary and accent');
  }

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

  let out = html.replace(COLOR_TOKEN_RE, (token) => {
    const parsed = parseColor(token);
    if (!parsed) return token;
    const role = mapColor(parsed);
    replacements++;
    return formatRgba(role.r, role.g, role.b, parsed.a);
  });

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

  const ATTR_NAMED_RE = new RegExp(
    `\\b(bgcolor|color)\\s*=\\s*(["'])(${Object.keys(NAMED_COLORS).join('|')})\\2`,
    'gi',
  );
  out = out.replace(ATTR_NAMED_RE, (m, attr, quote, value) => {
    const hex = NAMED_COLORS[value.toLowerCase()];
    const parsed = hex ? parseColor(hex) : null;
    if (!parsed) return m;
    const role = mapColor(parsed);
    replacements++;
    return `${attr}=${quote}${rgbToHex({ r: role.r, g: role.g, b: role.b })}${quote}`;
  });

  return {
    html: out,
    replacements,
    originalLength: html.length,
    newLength: out.length,
    originalTheme,
    newTheme,
    themeSwapped: originalTheme !== newTheme,
    pageBgDetected: pageBg ? rgbToHex(pageBg) : null,
  };
}
