// Brand color extraction utilities.
//
// Reads the concatenated text of a project section (Brief / Market Research /
// any uploaded brand-colors document) and pulls out hex codes mapped to the
// role they were labelled with ("primary", "accent", "CTA", "background"...).
//
// Heuristics, on purpose: we don't want to send a Claude call just to parse
// hex codes from a brand book. The parser is forgiving — it handles the most
// common ways a designer/brand doc lists colors:
//
//   primary: #A8E6CF
//   PRIMARY COLOR  #A8E6CF
//   • Primary — #A8E6CF (Cornflower)
//   primary = rgb(168, 230, 207)
//   --color-primary: #A8E6CF;
//   CTA background: #FF8B94
//   accent ............ #FFAAA5

import type { SectionFile } from './project-sections';

export type BrandColorRole =
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'background'
  | 'text'
  | 'ctaBackground'
  | 'ctaText'
  | 'success'
  | 'warning'
  | 'error'
  | 'border'
  | 'unknown';

export interface BrandColor {
  hex: string;            // normalized "#RRGGBB"
  role: BrandColorRole;
  rawLabel: string;       // original label from the doc, for the UI
  source: string;         // file name (or "notes")
  line: string;           // surrounding line, for debugging / preview
}

export interface BrandPalette {
  // Canonical roles, single value each (first match wins).
  primary?: string;
  secondary?: string;
  accent?: string;
  background?: string;
  text?: string;
  ctaBackground?: string;
  ctaText?: string;
  // Everything else keyed by its raw label, in case the user has more colors
  // than the canonical set.
  extras: Record<string, string>;
  // Full audit list (every detection with role + source).
  all: BrandColor[];
}

// ─── Role detection ──────────────────────────────────────────────────────────

const ROLE_KEYWORDS: Array<{ role: BrandColorRole; patterns: RegExp[] }> = [
  {
    role: 'ctaBackground',
    patterns: [
      /\bcta[\s_-]*(?:bg|background|btn|button|color)\b/i,
      /\bbutton[\s_-]*(?:bg|background|color|primary)\b/i,
      /\b(?:bottone|pulsante)\b/i,
    ],
  },
  {
    role: 'ctaText',
    patterns: [/\bcta[\s_-]*text\b/i, /\bbutton[\s_-]*text\b/i],
  },
  {
    role: 'background',
    patterns: [
      /\bbg\b/i,
      /\bbackground\b/i,
      /\bsfondo\b/i,
      /\bcanvas\b/i,
    ],
  },
  {
    role: 'text',
    patterns: [
      /\btext[\s_-]*color\b/i,
      /\bbody[\s_-]*text\b/i,
      /\bforeground\b/i,
      /\btesto\b/i,
      /\bcopy[\s_-]*color\b/i,
    ],
  },
  {
    role: 'primary',
    patterns: [/\bprimary\b/i, /\bprincipale\b/i, /\bbrand[\s_-]*color\b/i, /\bmain\b/i],
  },
  {
    role: 'secondary',
    patterns: [/\bsecondary\b/i, /\bsecondario\b/i],
  },
  {
    role: 'accent',
    patterns: [/\baccent\b/i, /\bhighlight\b/i, /\bevidenza\b/i],
  },
  {
    role: 'success',
    patterns: [/\bsuccess\b/i, /\bsuccesso\b/i, /\bok[\s_-]*color\b/i, /\bgreen\b/i],
  },
  {
    role: 'warning',
    patterns: [/\bwarning\b/i, /\bavviso\b/i, /\battenzione\b/i],
  },
  {
    role: 'error',
    patterns: [/\berror\b/i, /\berrore\b/i, /\bdanger\b/i, /\bred\b/i],
  },
  {
    role: 'border',
    patterns: [/\bborder\b/i, /\bbordo\b/i, /\bdivider\b/i],
  },
];

function inferRole(label: string): BrandColorRole {
  for (const { role, patterns } of ROLE_KEYWORDS) {
    if (patterns.some((re) => re.test(label))) return role;
  }
  return 'unknown';
}

// ─── Hex / rgb normalization ─────────────────────────────────────────────────

const HEX_RE = /#([0-9a-fA-F]{3,8})\b/g;
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)/gi;

function normHex(raw: string): string | null {
  const m = raw.replace(/^#/, '');
  if (m.length === 3) {
    return ('#' + m.split('').map((c) => c + c).join('')).toUpperCase();
  }
  if (m.length === 6) return ('#' + m).toUpperCase();
  if (m.length === 8) return ('#' + m.slice(0, 6)).toUpperCase(); // strip alpha
  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ─── Line-based extraction ───────────────────────────────────────────────────

interface RawHit {
  hex: string;
  rawLabel: string;
  line: string;
}

/** Pull every hex / rgb mention from a single line, with the label on its
 *  left side (the words preceding the color). */
function extractHitsFromLine(line: string): RawHit[] {
  const hits: RawHit[] = [];

  // Hex matches.
  let m: RegExpExecArray | null;
  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(line)) !== null) {
    const hex = normHex(m[0]);
    if (!hex) continue;
    const label = line.slice(0, m.index).trim();
    hits.push({ hex, rawLabel: cleanLabel(label), line: line.trim() });
  }

  // rgb()/rgba() matches.
  RGB_RE.lastIndex = 0;
  while ((m = RGB_RE.exec(line)) !== null) {
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    const hex = rgbToHex(r, g, b);
    const label = line.slice(0, m.index).trim();
    hits.push({ hex, rawLabel: cleanLabel(label), line: line.trim() });
  }

  return hits;
}

/** Trim noise from a label so the role detector has a clean string to match. */
function cleanLabel(raw: string): string {
  return raw
    // Strip CSS variable prefix.
    .replace(/^--/, '')
    // Strip leading bullets and numbering.
    .replace(/^[\s•·*\-—–=:|>]+/, '')
    // Strip trailing fillers and separators.
    .replace(/[\s.:=>—–\-]+$/, '')
    // Strip trailing color names in parens, e.g. "Primary (Cornflower)" → "Primary".
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Extract every brand color mention from a string, with role inference. */
export function extractBrandColorsFromText(
  text: string,
  source: string = 'text',
): BrandColor[] {
  if (!text || typeof text !== 'string') return [];
  const out: BrandColor[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const hits = extractHitsFromLine(line);
    for (const h of hits) {
      out.push({
        hex: h.hex,
        rawLabel: h.rawLabel,
        role: inferRole(h.rawLabel + ' ' + line),
        line: h.line,
        source,
      });
    }
  }
  return out;
}

/** Extract from every uploaded file in a section + the free notes. */
export function extractBrandColorsFromFiles(
  files: SectionFile[],
  notes: string = '',
): BrandColor[] {
  const out: BrandColor[] = [];
  for (const f of files || []) {
    out.push(...extractBrandColorsFromText(f.content || '', f.name));
  }
  if (notes?.trim()) out.push(...extractBrandColorsFromText(notes, 'notes'));
  return out;
}

/** Reduce a flat list of detections into a canonical palette. First
 *  unambiguous detection per role wins; ambiguous "unknown" colors are
 *  kept in `extras` keyed by their raw label so the user can see them. */
export function buildPalette(colors: BrandColor[]): BrandPalette {
  const palette: BrandPalette = { extras: {}, all: colors };
  const seenHex = new Set<string>();

  for (const c of colors) {
    if (c.role === 'unknown') continue;
    const key = c.role as keyof BrandPalette;
    if (key === 'extras' || key === 'all') continue;
    if (palette[key]) continue; // first wins
    (palette as Record<string, unknown>)[key] = c.hex;
    seenHex.add(c.hex);
  }

  // Fill `extras` with named-but-unmapped colors, deduped on hex.
  for (const c of colors) {
    if (c.role !== 'unknown') continue;
    if (seenHex.has(c.hex)) continue;
    if (!c.rawLabel) continue;
    if (palette.extras[c.rawLabel]) continue;
    palette.extras[c.rawLabel] = c.hex;
    seenHex.add(c.hex);
  }

  return palette;
}

/** Convenience: section data → palette in one call. */
export function paletteFromSection(
  files: SectionFile[],
  notes: string = '',
): BrandPalette {
  return buildPalette(extractBrandColorsFromFiles(files, notes));
}

/** Pretty role label for the UI. */
export function roleLabel(role: BrandColorRole): string {
  switch (role) {
    case 'ctaBackground': return 'CTA background';
    case 'ctaText': return 'CTA text';
    case 'primary': return 'Primary';
    case 'secondary': return 'Secondary';
    case 'accent': return 'Accent';
    case 'background': return 'Background';
    case 'text': return 'Text';
    case 'success': return 'Success';
    case 'warning': return 'Warning';
    case 'error': return 'Error';
    case 'border': return 'Border';
    case 'unknown': return 'Unlabelled';
  }
}
