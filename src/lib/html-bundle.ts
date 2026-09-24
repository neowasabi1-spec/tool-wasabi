/**
 * Turn an uploaded HTML file, a page folder, or a .zip into a self-contained
 * snapshot (CSS/images inlined) so srcdoc preview is not a wall of unstyled text.
 */

const MAX_CSS = 800 * 1024;
const MAX_IMG = 400 * 1024;
const MAX_IMGS = 50;
const MAX_ZIP = 40 * 1024 * 1024;

const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

export type BundleFile = { path: string; bytes: Uint8Array };

function u16(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}

function u32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot unpack zip files.');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzipFiles(buf: ArrayBuffer): Promise<BundleFile[]> {
  const u8 = new Uint8Array(buf);
  const out: BundleFile[] = [];
  let i = 0;
  while (i + 30 <= u8.length) {
    const sig = u32(u8, i);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50) break;
    const flags = u16(u8, i + 6);
    const method = u16(u8, i + 8);
    let compSize = u32(u8, i + 18);
    const nameLen = u16(u8, i + 26);
    const extraLen = u16(u8, i + 28);
    const name = new TextDecoder().decode(u8.slice(i + 30, i + 30 + nameLen)).replace(/\\/g, '/');
    let dataStart = i + 30 + nameLen + extraLen;
    if (flags & 8) {
      // Sizes live in the data descriptor after the payload — skip this entry.
      break;
    }
    const compressed = u8.slice(dataStart, dataStart + compSize);
    let bytes: Uint8Array;
    if (method === 0) bytes = compressed;
    else if (method === 8) bytes = await inflateRaw(compressed);
    else {
      i = dataStart + compSize;
      continue;
    }
    if (name && !name.endsWith('/')) out.push({ path: name.replace(/^\.\//, ''), bytes });
    i = dataStart + compSize;
  }
  return out;
}

export function posixJoin(fromFile: string, rel: string): string | null {
  const t = String(rel || '').trim();
  if (!t || /^(?:data:|blob:|https?:|\/\/|#|mailto:|tel:|javascript:)/i.test(t)) return null;
  const clean = t.split('?')[0].split('#')[0].replace(/\\/g, '/');
  const dir = fromFile.replace(/\\/g, '/').split('/');
  dir.pop();
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') dir.pop();
    else dir.push(part);
  }
  return dir.join('/');
}

function lookup(files: Map<string, Uint8Array>, want: string): Uint8Array | null {
  const n = want.replace(/\\/g, '/').replace(/^\.\//, '');
  if (files.has(n)) return files.get(n) || null;
  const lower = n.toLowerCase();
  for (const [k, v] of files) {
    if (k.replace(/\\/g, '/').toLowerCase() === lower) return v;
    if (k.replace(/\\/g, '/').endsWith('/' + n) || k.replace(/\\/g, '/').endsWith(n)) return v;
  }
  return null;
}

export function pickHtmlPath(files: Map<string, Uint8Array>): string | null {
  const paths = Array.from(files.keys());
  const htmls = paths.filter((p) => /\.html?$/i.test(p) && !/\/__MACOSX\//i.test(p));
  if (!htmls.length) return null;
  const index = htmls.find((p) => /(?:^|\/)index\.html?$/i.test(p));
  return index || htmls[0];
}

export function inlineHtmlFromBundle(html: string, htmlPath: string, files: Map<string, Uint8Array>): {
  html: string;
  cssInlined: number;
  imgInlined: number;
} {
  let out = html;
  let cssInlined = 0;
  let imgInlined = 0;

  out = out.replace(/<link\b([^>]*)\/?>/gi, (full, attrs: string) => {
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(attrs)) return full;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    const resolved = href ? posixJoin(htmlPath, href) : null;
    const bytes = resolved ? lookup(files, resolved) : null;
    if (!bytes || bytes.byteLength > MAX_CSS) return full;
    cssInlined += 1;
    const css = new TextDecoder().decode(bytes).replace(/<\/style/gi, '<\\/style');
    return `<style data-inlined-from="${String(href).replace(/"/g, '&quot;')}">${css}</style>`;
  });

  out = out.replace(
    /\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi,
    (full, attr: string, q: string, href: string) => {
      if (imgInlined >= MAX_IMGS) return full;
      const resolved = posixJoin(htmlPath, href);
      if (!resolved) return full;
      const ext = `.${resolved.split('.').pop()?.toLowerCase() || ''}`;
      const mime = IMG_MIME[ext];
      if (!mime) return full;
      const bytes = lookup(files, resolved);
      if (!bytes || bytes.byteLength > MAX_IMG) return full;
      imgInlined += 1;
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return `${attr}=${q}data:${mime};base64,${btoa(binary)}${q}`;
    },
  );

  return { html: out, cssInlined, imgInlined };
}

export function remainingRelativeStylesheets(html: string): number {
  const re = /<link\b([^>]*)\/?>/gi;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(attrs)) continue;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (href && !/^(?:data:|https?:|\/\/)/i.test(href)) n += 1;
  }
  return n;
}

export async function snapshotFromUploadFiles(fileList: File[] | FileList): Promise<{
  html: string;
  name: string;
  cssInlined: number;
  imgInlined: number;
}> {
  const files = Array.from(fileList);
  if (!files.length) throw new Error('No file selected.');

  const map = new Map<string, Uint8Array>();
  let fallbackName = 'page.html';

  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    if (files[0].size > MAX_ZIP) throw new Error('Zip is too large (max 40MB).');
    const entries = await unzipFiles(await files[0].arrayBuffer());
    for (const e of entries) map.set(e.path, e.bytes);
    fallbackName = files[0].name.replace(/\.zip$/i, '.html');
  } else {
    for (const f of files) {
      const rel =
        ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name)
          .replace(/\\/g, '/')
          .replace(/^\.\//, '');
      if (/\.zip$/i.test(f.name) && files.length === 1) continue;
      map.set(rel, new Uint8Array(await f.arrayBuffer()));
    }
    fallbackName = files.find((f) => /\.html?$/i.test(f.name))?.name || fallbackName;
  }

  const htmlPath = pickHtmlPath(map);
  if (!htmlPath) throw new Error('No HTML file found in the upload.');
  const raw = map.get(htmlPath);
  if (!raw) throw new Error('Could not read the HTML file.');
  const html = new TextDecoder().decode(raw);
  const inlined = inlineHtmlFromBundle(html, htmlPath, map);
  return {
    html: inlined.html,
    name: htmlPath.split('/').pop() || fallbackName,
    cssInlined: inlined.cssInlined,
    imgInlined: inlined.imgInlined,
  };
}
