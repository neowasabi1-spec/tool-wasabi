/**
 * Competitor landing media — images / GIFs / videos pulled out of saved
 * Competitor Library landings and reused by Chimera swipe.
 *
 * Stored as project_files rows with file_type = 'landing_media'
 * (original_name = "kind|sourceUrl") so no extra table is required.
 */

export const LANDING_MEDIA_TYPE = 'landing_media';

export type LandingMediaKind = 'image' | 'gif' | 'video';

export type LandingMediaItem = {
  id: number | string;
  kind: LandingMediaKind;
  sourceUrl: string;
  storedUrl: string;
  filePath: string;
  name: string;
};

type Sb = {
  from: (table: string) => any;
  storage: { from: (bucket: string) => any };
};

const BUCKET = 'project-files';
const MAX_PER_PAGE = 24;
const MAX_PER_RUN = 60;
const MAX_BYTES: Record<LandingMediaKind, number> = {
  image: 8_000_000,
  gif: 12_000_000,
  video: 22_000_000,
};

const JUNK_RE =
  /logo|icon|favicon|sprite|pixel|1x1|tracking|analytics|doubleclick|facebook\.com\/tr|google-analytics|hotjar|badge|payment|visa|mastercard|amex|paypal|klarna|apple-?pay|g-?pay|emoji|loader|spinner|spacer|blank\.|placeholder|trustpilot|cookie/i;

function absolutize(src: string, pageUrl: string): string {
  const s = String(src || '').trim();
  if (!s || s.startsWith('data:') || s.startsWith('blob:')) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (!pageUrl) return '';
  try {
    return new URL(s, pageUrl).href;
  } catch {
    return '';
  }
}

export function classifyLandingAsset(url: string): LandingMediaKind | null {
  const u = url.split('#')[0].split('?')[0].toLowerCase();
  if (/\.(svg|ico|woff2?|ttf|eot)(\b|$)/.test(u)) return null;
  if (/\.(mp4|webm|mov|m4v|ogv)(\b|$)/.test(u) || /\/video\//i.test(u)) return 'video';
  if (/\.gif(\b|$)/.test(u)) return 'gif';
  if (/\.(jpe?g|png|webp|avif|bmp)(\b|$)/.test(u)) return 'image';
  if (/\.(mp3|wav|m4a|aac)(\b|$)/.test(u)) return null;
  // CDN paths without an extension — treat as image if it looks like one.
  if (/\/(image|img|media|cdn|uploads|wp-content|assets)\//i.test(u)) return 'image';
  return null;
}

function pushAsset(
  out: Array<{ url: string; kind: LandingMediaKind }>,
  seen: Set<string>,
  raw: string,
  pageUrl: string,
) {
  const abs = absolutize(raw, pageUrl);
  if (!abs || seen.has(abs) || JUNK_RE.test(abs)) return;
  const kind = classifyLandingAsset(abs);
  if (!kind) return;
  seen.add(abs);
  out.push({ url: abs, kind });
}

function largestSrcset(srcset: string): string {
  const parts = srcset.split(',').map((p) => p.trim()).filter(Boolean);
  let best = '';
  let bestW = -1;
  for (const p of parts) {
    const [u, w] = p.split(/\s+/);
    const n = parseInt(String(w || '').replace(/[^\d]/g, ''), 10) || 0;
    if (n >= bestW && u) {
      bestW = n;
      best = u;
    }
  }
  return best || (parts[0] || '').split(/\s+/)[0] || '';
}

/** Pull image / gif / video URLs out of a landing HTML document. */
export function collectLandingAssetUrls(
  html: string,
  pageUrl: string,
): Array<{ url: string; kind: LandingMediaKind }> {
  const out: Array<{ url: string; kind: LandingMediaKind }> = [];
  const seen = new Set<string>();
  const h = String(html || '');
  if (!h) return out;

  const attrRe = /\b(?:src|data-src|data-lazy-src|poster)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(h)) !== null) pushAsset(out, seen, m[1], pageUrl);

  const srcsetRe = /\bsrcset\s*=\s*["']([^"']+)["']/gi;
  while ((m = srcsetRe.exec(h)) !== null) pushAsset(out, seen, largestSrcset(m[1]), pageUrl);

  const cssRe = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
  while ((m = cssRe.exec(h)) !== null) pushAsset(out, seen, m[1], pageUrl);

  return out.slice(0, MAX_PER_PAGE);
}

function encodeName(kind: LandingMediaKind, sourceUrl: string): string {
  return `${kind}|${sourceUrl}`.slice(0, 480);
}

function decodeName(name: string): { kind: LandingMediaKind; sourceUrl: string } {
  const pipe = name.indexOf('|');
  if (pipe > 0) {
    const kind = name.slice(0, pipe) as LandingMediaKind;
    if (kind === 'image' || kind === 'gif' || kind === 'video') {
      return { kind, sourceUrl: name.slice(pipe + 1) };
    }
  }
  return { kind: classifyLandingAsset(name) || 'image', sourceUrl: name };
}

function publicUrl(sb: Sb, path: string): string {
  const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
  return data?.publicUrl || '';
}

export async function listLandingMedia(sb: Sb, projectId: string): Promise<LandingMediaItem[]> {
  const { data, error } = await sb
    .from('project_files')
    .select('id, file_path, original_name, created_at')
    .eq('project_id', projectId)
    .eq('file_type', LANDING_MEDIA_TYPE)
    .order('created_at', { ascending: true });
  if (error || !data) return [];
  return (data as Array<{ id: number | string; file_path: string; original_name: string }>).map((row) => {
    const meta = decodeName(row.original_name || '');
    const storedUrl = publicUrl(sb, row.file_path);
    return {
      id: row.id,
      kind: meta.kind,
      sourceUrl: meta.sourceUrl,
      storedUrl,
      filePath: row.file_path,
      name: meta.sourceUrl.split('/').pop()?.split('?')[0] || meta.kind,
    };
  });
}

async function downloadAsset(
  url: string,
  kind: LandingMediaKind,
): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(18_000),
      headers: { Accept: kind === 'video' ? 'video/*,*/*' : 'image/*,*/*' },
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (kind !== 'video' && ct && !ct.startsWith('image/') && !ct.includes('octet-stream')) return null;
    if (kind === 'video' && ct.startsWith('text/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 800 || buf.length > MAX_BYTES[kind]) return null;
    return { buf, contentType: ct || (kind === 'video' ? 'video/mp4' : kind === 'gif' ? 'image/gif' : 'image/jpeg') };
  } catch {
    return null;
  }
}

function extFor(kind: LandingMediaKind, ct: string, url: string): string {
  if (kind === 'video') {
    if (/webm/.test(ct) || /\.webm/i.test(url)) return 'webm';
    if (/quicktime|mov/.test(ct) || /\.mov/i.test(url)) return 'mov';
    return 'mp4';
  }
  if (kind === 'gif' || /gif/.test(ct)) return 'gif';
  if (/webp/.test(ct) || /\.webp/i.test(url)) return 'webp';
  if (/png/.test(ct) || /\.png/i.test(url)) return 'png';
  return 'jpg';
}

/** Download one landing's assets into the project's Image landings library. */
export async function extractLandingMediaFromHtml(
  sb: Sb,
  args: { projectId: string; html: string; pageUrl: string; ownerUserId?: string | null },
): Promise<{ saved: number; skipped: number }> {
  const assets = collectLandingAssetUrls(args.html, args.pageUrl);
  if (!assets.length) return { saved: 0, skipped: 0 };
  const existing = await listLandingMedia(sb, args.projectId);
  const have = new Set(existing.map((e) => e.sourceUrl));
  let saved = 0;
  let skipped = 0;
  for (const a of assets) {
    if (have.has(a.url)) {
      skipped++;
      continue;
    }
    if (existing.length + saved >= MAX_PER_RUN) break;
    const dl = await downloadAsset(a.url, a.kind);
    if (!dl) {
      skipped++;
      continue;
    }
    const ext = extFor(a.kind, dl.contentType, a.url);
    const key = `${args.projectId}/${LANDING_MEDIA_TYPE}/${Date.now()}_${saved}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(key, dl.buf, {
      contentType: dl.contentType,
      upsert: false,
    });
    if (upErr) {
      skipped++;
      continue;
    }
    const row: Record<string, unknown> = {
      project_id: args.projectId,
      file_type: LANDING_MEDIA_TYPE,
      file_path: key,
      original_name: encodeName(a.kind, a.url),
    };
    if (args.ownerUserId) row.owner_user_id = args.ownerUserId;
    const { error: insErr } = await sb.from('project_files').insert(row);
    if (insErr) {
      await sb.storage.from(BUCKET).remove([key]).catch(() => undefined);
      skipped++;
      continue;
    }
    have.add(a.url);
    saved++;
  }
  return { saved, skipped };
}

/** Walk every competitor landing saved on the project and fill Image landings. */
export async function extractLandingMediaForProject(
  sb: Sb,
  projectId: string,
  ownerUserId?: string | null,
): Promise<{ saved: number; skipped: number; pages: number }> {
  const { data: rows } = await sb
    .from('archived_funnels')
    .select('id, steps')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(80);
  let saved = 0;
  let skipped = 0;
  let pages = 0;
  for (const row of rows || []) {
    const steps = Array.isArray(row.steps) ? (row.steps as Array<Record<string, unknown>>) : [];
    for (const step of steps) {
      const pageId = String(step.page_id || row.id || '');
      const cloned =
        step.cloned_data && typeof step.cloned_data === 'object'
          ? (step.cloned_data as Record<string, unknown>)
          : {};
      const pageUrl = String(step.url_to_swipe || cloned.source_url || '');
      let html = typeof cloned.html === 'string' ? cloned.html : '';
      if (!html && pageId) {
        const { data: ph } = await sb
          .from('page_html')
          .select('html')
          .eq('page_id', pageId)
          .eq('kind', 'cloned')
          .eq('variant', 'desktop')
          .maybeSingle();
        html = typeof ph?.html === 'string' ? ph.html : '';
      }
      if (!html) continue;
      pages++;
      const r = await extractLandingMediaFromHtml(sb, {
        projectId,
        html,
        pageUrl,
        ownerUserId,
      });
      saved += r.saved;
      skipped += r.skipped;
      if (saved >= MAX_PER_RUN) return { saved, skipped, pages };
    }
  }
  return { saved, skipped, pages };
}
