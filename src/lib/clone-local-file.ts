/**
 * Clone an HTML file from disk (file:// or absolute path) and inline
 * sibling CSS/images so preview does not 404 on ../../../assets/...
 */

import fs from 'fs';
import path from 'path';

const MAX_CSS = 800 * 1024;
const MAX_IMG = 400 * 1024;
const MAX_IMGS = 50;

const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

export function parseLocalHtmlPath(raw: string): string | null {
  const u = String(raw || '').trim();
  if (!u) return null;
  if (u.startsWith('file:')) {
    try {
      let p = decodeURIComponent(new URL(u).pathname);
      if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      return p;
    } catch {
      return null;
    }
  }
  if (u.startsWith('/') && /\.html?$/i.test(u)) return u;
  return null;
}

function readIfExists(filePath: string, maxBytes: number): Buffer | null {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null;
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function resolveFromHtml(htmlFile: string, href: string): string | null {
  const t = String(href || '').trim();
  if (!t || /^(?:data:|blob:|https?:|\/\/|#|mailto:|tel:|javascript:)/i.test(t)) return null;
  const clean = t.split('?')[0].split('#')[0];
  try {
    return path.normalize(path.join(path.dirname(htmlFile), clean));
  } catch {
    return null;
  }
}

export function loadLocalHtmlSnapshot(htmlFile: string): string {
  const html = fs.readFileSync(htmlFile, 'utf8');
  let out = html;
  let imgCount = 0;

  out = out.replace(/<link\b([^>]*)\/?>/gi, (full, attrs: string) => {
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(attrs)) return full;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    const file = href ? resolveFromHtml(htmlFile, href) : null;
    const buf = file ? readIfExists(file, MAX_CSS) : null;
    if (!buf) return full;
    const css = buf.toString('utf8').replace(/<\/style/gi, '<\\/style');
    return `<style data-inlined-from="${String(href).replace(/"/g, '&quot;')}">${css}</style>`;
  });

  out = out.replace(
    /\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi,
    (full, attr: string, q: string, href: string) => {
      if (imgCount >= MAX_IMGS) return full;
      const file = resolveFromHtml(htmlFile, href);
      if (!file) return full;
      const ext = path.extname(file).toLowerCase();
      const mime = IMG_MIME[ext];
      if (!mime) return full;
      const buf = readIfExists(file, MAX_IMG);
      if (!buf) return full;
      imgCount += 1;
      return `${attr}=${q}data:${mime};base64,${buf.toString('base64')}${q}`;
    },
  );

  return out;
}
