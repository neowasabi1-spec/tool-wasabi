/**
 * Winner / promising tiers — same rules as Competitor Library.
 * Longevity + still-active is the cheap proxy; manual is_winner always wins.
 */

export const WINNER_DAYS = 21;
export const PROMISING_DAYS = 10;

export type WinnerSignals = {
  is_winner?: boolean | string | null;
  ad_started_at?: string | null;
  ad_active?: string | null;
  is_active?: string | null;
};

export type WinnerTier = 'winner' | 'promising' | null;

export function daysRunning(ad: WinnerSignals): number | null {
  if (!ad.ad_started_at) return null;
  const t = new Date(ad.ad_started_at).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

export function winnerTier(ad: WinnerSignals): WinnerTier {
  if (ad.is_winner === true || ad.is_winner === 'true') return 'winner';
  const active = ad.ad_active === 'true' || ad.is_active === 'true';
  const d = daysRunning(ad);
  if (d !== null && active) {
    if (d >= WINNER_DAYS) return 'winner';
    if (d >= PROMISING_DAYS) return 'promising';
  }
  return null;
}

/** 0 = winner, 1 = promising, 2 = other */
export function tierRank(ad: WinnerSignals): number {
  const t = winnerTier(ad);
  return t === 'winner' ? 0 : t === 'promising' ? 1 : 2;
}

export function sortByWinnerTier<T extends WinnerSignals & { impressions?: number | string | null }>(
  ads: T[],
): T[] {
  return [...ads].sort((a, b) => {
    const tr = tierRank(a) - tierRank(b);
    if (tr !== 0) return tr;
    const da = daysRunning(a) ?? -1;
    const db = daysRunning(b) ?? -1;
    if (db !== da) return db - da;
    const ia = Number(a.impressions) || 0;
    const ib = Number(b.impressions) || 0;
    return ib - ia;
  });
}
