import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/projecthub/projects/:id/dashboard
 * Aggregated project overview: competitors, ads (and winners), funnels /
 * landings, creatives, shots — everything the Dashboard section charts.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [brandsQ, adsQ, funnelsQ, creativesQ, shotsQ] = await Promise.all([
    supabaseAdmin
      .from('competitor_brands')
      .select('id, name, created_at')
      .eq('project_id', id),
    supabaseAdmin
      .from('competitor_ads')
      .select('id, brand_id, media_type, is_winner, ad_variants, ad_started_at, name, headline, file_path, created_at')
      .eq('project_id', id),
    supabaseAdmin
      .from('archived_funnels')
      .select('id, name, steps, created_at')
      .eq('project_id', id),
    supabaseAdmin
      .from('creative_templates')
      .select('id, media_type')
      .eq('project_id', id),
    supabaseAdmin
      .from('competitor_shots')
      .select('id, clean_path, has_text')
      .eq('project_id', id),
  ]);

  type Brand = { id: number; name: string; created_at: string };
  type Ad = {
    id: number; brand_id: number; media_type: string; is_winner: boolean;
    ad_variants: number; ad_started_at: string | null; name: string;
    headline: string; file_path: string; created_at: string;
  };

  // "My Footage" is an internal pseudo-brand, not a competitor.
  const internalBrands = new Set(
    ((brandsQ.data || []) as Brand[]).filter(b => b.name === 'My Footage').map(b => b.id),
  );
  const brands = ((brandsQ.data || []) as Brand[]).filter(b => !internalBrands.has(b.id));
  const ads = ((adsQ.data || []) as Ad[]).filter(a => !internalBrands.has(a.brand_id));

  const brandName = new Map(brands.map(b => [b.id, b.name]));

  // Same heuristic as the Ads Library: a long-running ad is a winner even
  // without the manual flag. Advertisers cut losers fast.
  const daysActive = (a: Ad) =>
    a.ad_started_at ? Math.max(0, Math.round((Date.now() - new Date(a.ad_started_at).getTime()) / 86400000)) : 0;
  const isWinner = (a: Ad) => !!a.is_winner || daysActive(a) >= 21;
  const winnersCount = ads.filter(isWinner).length;

  // ── competitors ranked by ads / winners ──
  const perBrand = new Map<number, { ads: number; winners: number; video: number; image: number }>();
  for (const a of ads) {
    const e = perBrand.get(a.brand_id) || { ads: 0, winners: 0, video: 0, image: 0 };
    e.ads++;
    if (isWinner(a)) e.winners++;
    if (a.media_type === 'video') e.video++; else e.image++;
    perBrand.set(a.brand_id, e);
  }
  const topCompetitors = brands
    .map(b => ({ id: b.id, name: b.name, ...(perBrand.get(b.id) || { ads: 0, winners: 0, video: 0, image: 0 }) }))
    .sort((x, y) => y.winners - x.winners || y.ads - x.ads)
    .slice(0, 8);

  // ── best ads: winners first, then most variants, then longest running ──
  const topAds = [...ads]
    .sort((x, y) =>
      Number(isWinner(y)) - Number(isWinner(x)) ||
      (y.ad_variants || 0) - (x.ad_variants || 0) ||
      daysActive(y) - daysActive(x))
    .slice(0, 8)
    .map(a => ({
      id: a.id,
      brand_id: a.brand_id,
      brand: brandName.get(a.brand_id) || '',
      name: a.name || a.headline || 'Ad',
      media_type: a.media_type,
      file_path: a.file_path,
      is_winner: isWinner(a),
      variants: a.ad_variants || 0,
      days: daysActive(a),
    }));

  // ── ads added per day, last 30 days ──
  const cutoff = Date.now() - 30 * 86400000;
  const byDay = new Map<string, number>();
  for (const a of ads) {
    const t = new Date(a.created_at).getTime();
    if (t < cutoff) continue;
    const key = a.created_at.slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }
  const timeline: { date: string; ads: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    timeline.push({ date: d.slice(5), ads: byDay.get(d) || 0 });
  }

  // ── funnels / landings ──
  type FunnelRow = { id: number; name: string; steps: unknown; created_at: string };
  const funnelRows = ((funnelsQ.data || []) as FunnelRow[]).map(f => ({
    id: f.id,
    name: f.name,
    steps: Array.isArray(f.steps) ? f.steps.length : 1,
    created_at: f.created_at,
  }));
  const multiStep = funnelRows.filter(f => f.steps > 1);
  const totalPages = funnelRows.reduce((s, f) => s + f.steps, 0);

  // ── creatives / shots ──
  type Creative = { id: number; media_type: string };
  const creatives = ((creativesQ.data || []) as Creative[]).filter(c => c.media_type !== 'folder');
  type Shot = { id: number; clean_path?: string | null; has_text?: boolean | null };
  const shots = (shotsQ.data || []) as Shot[];

  return NextResponse.json({
    competitors: { total: brands.length, top: topCompetitors },
    ads: {
      total: ads.length,
      video: ads.filter(a => a.media_type === 'video').length,
      image: ads.filter(a => a.media_type !== 'video').length,
      winners: winnersCount,
      top: topAds,
      timeline,
    },
    funnels: {
      rows: funnelRows.length,
      funnels: multiStep.length,
      landings: funnelRows.length - multiStep.length,
      pages: totalPages,
      recent: funnelRows
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 6),
    },
    creatives: {
      total: creatives.length,
      video: creatives.filter(c => c.media_type === 'video').length,
      image: creatives.filter(c => c.media_type === 'image').length,
    },
    shots: {
      total: shots.length,
      cleaned: shots.filter(s => !!s.clean_path || s.has_text === false).length,
    },
  });
}
