/**
 * Parse Chimera Protocol Angle Matrix + platform ads into the rows the
 * Creative UI already knows how to render (`creative_angles`,
 * `creative_generated`). Also used to backfill a run that wrote only
 * `project_files` / `creative_outputs`.
 */

export interface ParsedAngle {
  name: string;
  body: string;
}

export interface ParsedPlatformAd {
  angle: string;
  platform: 'meta' | 'tiktok' | 'google';
  text: string;
}

export function parseAngles(raw: string): ParsedAngle[] {
  const lines = (raw || '').split('\n');
  const items: ParsedAngle[] = [];
  let cur: ParsedAngle | null = null;
  const headRe = /^#{2,3}\s*ANGLE\s*\d*\s*[—:\-–]\s*(.+?)\s*$/i;
  const altRe = /^ANGLE\s*\d*\s*[—:\-–]\s*(.+?)\s*$/i;
  for (const ln of lines) {
    const m = ln.match(headRe) || ln.match(altRe);
    if (m) {
      if (cur) items.push(cur);
      cur = { name: m[1].replace(/[*_`]/g, '').trim().slice(0, 200), body: '' };
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + ln;
    }
  }
  if (cur) items.push(cur);
  return items.map((a) => ({ name: a.name, body: a.body.trim() })).filter((a) => a.name);
}

export function parseMultiPlatformAds(raw: string): ParsedPlatformAd[] {
  const out: ParsedPlatformAd[] = [];
  const blocks = (raw || '').split(/\n-{3,}\s*\n/g).map((b) => b.trim()).filter(Boolean);
  for (const b of blocks) {
    const nameM = b.match(/^#{0,3}\s*ANGLE\s*\d*\s*[—:\-–]\s*(.+?)\s*$/im);
    const angle = (nameM ? nameM[1] : 'Concept').replace(/[*_`]/g, '').trim().slice(0, 200);
    const markers: Array<{ p: ParsedPlatformAd['platform']; re: RegExp }> = [
      { p: 'meta', re: /\[\s*META\s*\]/i },
      { p: 'tiktok', re: /\[\s*TIKTOK\s*\]/i },
      { p: 'google', re: /\[\s*GOOGLE\s*\]/i },
    ];
    const hits = markers
      .map((m) => ({ p: m.p, idx: b.search(m.re) }))
      .filter((h) => h.idx >= 0)
      .sort((a, c) => a.idx - c.idx);
    if (hits.length === 0) {
      out.push({ angle, platform: 'meta', text: b });
      continue;
    }
    for (let i = 0; i < hits.length; i++) {
      const start = hits[i].idx;
      const end = i + 1 < hits.length ? hits[i + 1].idx : b.length;
      const text = b.slice(start, end).replace(/^\[[^\]]+\]\s*/, '').trim();
      if (text) out.push({ angle, platform: hits[i].p, text });
    }
  }
  return out;
}

function mdField(body: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:[-*]\\s*)?\\*\\*${escaped}\\:?\\*\\*\\s*[:—–-]?\\s*(.+)`,
    'i',
  );
  const m = body.match(re);
  return (m?.[1] || '').replace(/^["“”'`]+|["“”'`]+$/g, '').trim();
}

function pickLine(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}:\\s*([\\s\\S]+?)(?=\\n[A-Z][A-Z \\-]+:|\\n\\[|$)`, 'im');
  return (text.match(re)?.[1] || '').trim();
}

export function angleRowFromParsed(projectId: string, a: ParsedAngle) {
  const bigIdea = mdField(a.body, 'Big idea / promise') || mdField(a.body, 'Big idea');
  const mechanism = mdField(a.body, 'Unique mechanism leaned on');
  const awareness = mdField(a.body, 'Awareness level');
  const emotion = mdField(a.body, 'Core emotion');
  const soph = mdField(a.body, 'Sophistication move');
  const gap = mdField(a.body, 'Competitor gap it exploits');
  const proof = mdField(a.body, 'Proof required');
  const hook = mdField(a.body, 'Sample hook');
  return {
    project_id: projectId,
    angle_name: a.name.slice(0, 300),
    rationale: (bigIdea || mechanism || a.body).slice(0, 4000),
    competitor_insights: (gap || '').slice(0, 4000),
    our_ads_insights: (proof || 'Chimera Protocol').slice(0, 4000),
    market_insights: [awareness, emotion].filter(Boolean).join(' — ').slice(0, 4000),
    ad_style: (soph.split(/[—–-]/)[0] || soph || 'mechanism').trim().slice(0, 120),
    target: (awareness || '').slice(0, 300),
    hook_angle: (hook || '').slice(0, 500),
  };
}

const PLATFORM_FORMAT: Record<ParsedPlatformAd['platform'], string> = {
  meta: 'Meta',
  tiktok: 'TikTok',
  google: 'Google',
};

export function generatedRowFromParsed(
  projectId: string,
  ad: ParsedPlatformAd,
  idx: number,
  angleId: number | null = null,
) {
  const headline =
    pickLine(ad.text, 'HEADLINE')
    || pickLine(ad.text, 'HEADLINES')
    || pickLine(ad.text, 'HOOK')
    || ad.angle;
  const hook =
    pickLine(ad.text, 'HOOK')
    || pickLine(ad.text, 'DESCRIPTION')
    || pickLine(ad.text, 'CTA')
    || '';
  const body =
    pickLine(ad.text, 'PRIMARY TEXT')
    || pickLine(ad.text, 'SCRIPT')
    || pickLine(ad.text, 'DESCRIPTIONS')
    || ad.text;
  return {
    project_id: projectId,
    angle_id: angleId,
    angle_name: ad.angle.slice(0, 300),
    headline: headline.slice(0, 500),
    hook: hook.slice(0, 500),
    body: body.slice(0, 4000),
    ad_style: PLATFORM_FORMAT[ad.platform],
    target: '',
    format: PLATFORM_FORMAT[ad.platform],
    gradient_idx: String(idx % 8),
    status: 'draft',
    generation_notes: `[CHIMERA][${ad.platform.toUpperCase()}]\n${ad.text}`.slice(0, 8000),
  };
}

type Sb = {
  from: (table: string) => any;
  storage: { from: (bucket: string) => { download: (path: string) => Promise<{ data: Blob | null }> } };
};

export async function loadProjectFileText(
  supabase: Sb,
  projectId: string,
  fileType: string,
): Promise<string> {
  const { data } = await supabase
    .from('project_files')
    .select('file_path, file_type, created_at')
    .eq('project_id', projectId)
    .eq('file_type', fileType)
    .order('created_at', { ascending: false })
    .limit(1);
  const path = data?.[0]?.file_path as string | undefined;
  if (!path) return '';
  const { data: blob } = await supabase.storage.from('project-files').download(path);
  if (!blob) return '';
  return (await blob.text()).trim();
}

/**
 * If Chimera already wrote documents / creative_outputs but the Creative
 * tables are empty, copy them over once so New Creatives shows the run.
 */
export async function backfillCreativeTables(
  supabase: Sb,
  projectId: string,
): Promise<{ angles: number; generated: number }> {
  let angles = 0;
  let generated = 0;

  const existingAngles = await supabase
    .from('creative_angles')
    .select('id')
    .eq('project_id', projectId);
  if (!existingAngles.error && !(existingAngles.data || []).length) {
    const md = await loadProjectFileText(supabase, projectId, 'angles');
    const parsed = parseAngles(md);
    if (parsed.length) {
      const rows = parsed.map((a) => angleRowFromParsed(projectId, a));
      const ins = await supabase.from('creative_angles').insert(rows);
      if (!ins.error) angles = rows.length;
    }
  }

  const existingGen = await supabase
    .from('creative_generated')
    .select('id')
    .eq('project_id', projectId);
  if (!existingGen.error && !(existingGen.data || []).length) {
    const outputs = await supabase
      .from('creative_outputs')
      .select('id, type, angle, concept_notes')
      .eq('project_id', projectId);
    const ads = ((outputs.data || []) as Array<{
      type?: string;
      angle?: string;
      concept_notes?: string;
    }>).map((o) => {
      const platform = String(o.type || 'meta_ad').replace(/_ad$/i, '').toLowerCase();
      const p = platform === 'tiktok' || platform === 'google' ? platform : 'meta';
      return {
        angle: String(o.angle || 'Concept'),
        platform: p as ParsedPlatformAd['platform'],
        text: String(o.concept_notes || ''),
      };
    }).filter((a) => a.text.trim());
    const parsed = ads.length ? ads : parseMultiPlatformAds(await loadProjectFileText(supabase, projectId, 'ads'));
    if (parsed.length) {
      const rows = parsed.map((ad, i) => generatedRowFromParsed(projectId, ad, i));
      const ins = await supabase.from('creative_generated').insert(rows);
      if (!ins.error) generated = rows.length;
    }
  }

  return { angles, generated };
}
